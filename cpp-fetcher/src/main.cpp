/*
 * Binance BTC Price Fetcher (WebSocket)
 * -------------------------------------
 * Maintains a persistent connection to Binance's ticker stream and stores
 * BTCUSDT ticks into PostgreSQL.
 *
 * Technologies: C++17, websocketpp, libpq, nlohmann/json
 */

#include <chrono>
#include <csignal>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <string>
#include <thread>

#include <libpq-fe.h>
#include <nlohmann/json.hpp>
#include <websocketpp/client.hpp>
#include <websocketpp/common/asio_ssl.hpp>
#include <websocketpp/config/asio_client.hpp>

using json = nlohmann::json;
using WsClient = websocketpp::client<websocketpp::config::asio_tls_client>;
using TlsContextPtr = websocketpp::lib::shared_ptr<websocketpp::lib::asio::ssl::context>;

volatile sig_atomic_t g_running = 1;

void signal_handler(int sig) {
    std::cout << "\n[INFO] Received signal " << sig << ", shutting down...\n";
    g_running = 0;
}

class BinanceWsFetcher {
public:
    BinanceWsFetcher() {
        db_host_ = env("DB_HOST", "localhost");
        db_port_ = env("DB_PORT", "5432");
        db_user_ = env("DB_USER", "admin");
        db_pass_ = env("DB_PASSWORD", "admin123");
        db_name_ = env("DB_NAME", "binance_db");
        min_store_interval_ms_ = std::stoi(env("MIN_STORE_INTERVAL_MS", "1000"));
        reconnect_delay_sec_ = std::stoi(env("WS_RECONNECT_DELAY_SEC", "5"));

        std::cout << "[INFO] Fetcher config: DB=" << db_host_ << ":" << db_port_
                  << "/" << db_name_ << " min_store_interval_ms="
                  << min_store_interval_ms_ << " reconnect_delay_sec="
                  << reconnect_delay_sec_ << "\n";
    }

    ~BinanceWsFetcher() {
        if (conn_) {
            PQfinish(conn_);
            conn_ = nullptr;
        }
    }

    bool connect_db() {
        if (conn_) {
            PQfinish(conn_);
            conn_ = nullptr;
        }

        std::string conn_str =
            "host=" + db_host_ + " port=" + db_port_ + " user=" + db_user_ +
            " password=" + db_pass_ + " dbname=" + db_name_;

        conn_ = PQconnectdb(conn_str.c_str());
        if (PQstatus(conn_) != CONNECTION_OK) {
            std::cerr << "[ERROR] DB connect failed: " << PQerrorMessage(conn_) << "\n";
            PQfinish(conn_);
            conn_ = nullptr;
            return false;
        }

        std::cout << "[INFO] Connected to PostgreSQL\n";
        return true;
    }

    bool store_tick(const std::string& price,
                    const std::string& high,
                    const std::string& low,
                    const std::string& volume,
                    const std::string& change_pct) {
        if (!conn_ || PQstatus(conn_) != CONNECTION_OK) {
            std::cout << "[WARN] Reconnecting to DB...\n";
            if (!connect_db()) {
                return false;
            }
        }

        const char* sql =
            "INSERT INTO btc_prices "
            "(symbol, price, high_24h, low_24h, volume_24h, price_change_pct) "
            "VALUES ($1, $2, $3, $4, $5, $6)";

        const char* params[6] = {
            "BTCUSDT", price.c_str(), high.c_str(), low.c_str(), volume.c_str(), change_pct.c_str()};

        PGresult* res = PQexecParams(conn_, sql, 6, nullptr, params, nullptr, nullptr, 0);
        if (PQresultStatus(res) != PGRES_COMMAND_OK) {
            std::cerr << "[ERROR] INSERT failed: " << PQerrorMessage(conn_) << "\n";
            PQclear(res);
            return false;
        }

        PQclear(res);
        return true;
    }

    bool handle_stream_message(const std::string& payload) {
        try {
            const auto now = std::chrono::steady_clock::now();
            if (last_store_time_.time_since_epoch().count() != 0) {
                const auto elapsed =
                    std::chrono::duration_cast<std::chrono::milliseconds>(now - last_store_time_).count();
                if (elapsed < min_store_interval_ms_) {
                    return true;
                }
            }

            const json data = json::parse(payload);
            if (!data.contains("c") || !data.contains("h") || !data.contains("l") ||
                !data.contains("v") || !data.contains("P")) {
                return false;
            }

            const std::string price = data["c"].get<std::string>();
            const std::string high = data["h"].get<std::string>();
            const std::string low = data["l"].get<std::string>();
            const std::string volume = data["v"].get<std::string>();
            const std::string change_pct = data["P"].get<std::string>();

            if (!store_tick(price, high, low, volume, change_pct)) {
                ++err_count_;
                return false;
            }

            last_store_time_ = now;
            ++ok_count_;
            log_tick(price, change_pct);
            return true;
        } catch (const json::exception& e) {
            std::cerr << "[ERROR] JSON parse failed: " << e.what() << "\n";
            ++err_count_;
            return false;
        }
    }

    TlsContextPtr on_tls_init() {
        auto ctx = websocketpp::lib::make_shared<websocketpp::lib::asio::ssl::context>(
            websocketpp::lib::asio::ssl::context::tlsv12_client);
        try {
            ctx->set_options(websocketpp::lib::asio::ssl::context::default_workarounds |
                             websocketpp::lib::asio::ssl::context::no_sslv2 |
                             websocketpp::lib::asio::ssl::context::no_sslv3 |
                             websocketpp::lib::asio::ssl::context::single_dh_use);
        } catch (const std::exception& e) {
            std::cerr << "[ERROR] TLS setup failed: " << e.what() << "\n";
        }
        return ctx;
    }

    void run() {
        if (!connect_db()) {
            std::cerr << "[FATAL] Cannot reach database at startup.\n";
            return;
        }

        const std::string uri = "wss://stream.binance.com:9443/ws/btcusdt@ticker";

        while (g_running) {
            try {
                WsClient client;
                client.clear_access_channels(websocketpp::log::alevel::all);
                client.clear_error_channels(websocketpp::log::elevel::all);
                client.init_asio();

                client.set_tls_init_handler([this](websocketpp::connection_hdl) {
                    return on_tls_init();
                });

                client.set_open_handler([](websocketpp::connection_hdl) {
                    std::cout << "[INFO] Connected to Binance WebSocket stream\n";
                });

                client.set_message_handler([this](websocketpp::connection_hdl,
                                                  WsClient::message_ptr msg) {
                    handle_stream_message(msg->get_payload());
                });

                client.set_fail_handler([&client](websocketpp::connection_hdl hdl) {
                    auto conn = client.get_con_from_hdl(hdl);
                    std::cerr << "[ERROR] WebSocket connection failed: "
                              << conn->get_ec().message() << "\n";
                });

                client.set_close_handler([&client](websocketpp::connection_hdl hdl) {
                    auto conn = client.get_con_from_hdl(hdl);
                    std::cout << "[WARN] WebSocket closed. code="
                              << conn->get_remote_close_code() << " reason="
                              << conn->get_remote_close_reason() << "\n";
                });

                websocketpp::lib::error_code ec;
                WsClient::connection_ptr con = client.get_connection(uri, ec);
                if (ec) {
                    std::cerr << "[ERROR] Could not create connection: " << ec.message() << "\n";
                } else {
                    client.connect(con);
                    client.run();
                }
            } catch (const std::exception& e) {
                std::cerr << "[ERROR] WebSocket loop exception: " << e.what() << "\n";
            }

            if (!g_running) {
                break;
            }

            std::cout << "[INFO] Reconnecting in " << reconnect_delay_sec_ << " seconds...\n";
            std::this_thread::sleep_for(std::chrono::seconds(reconnect_delay_sec_));
        }

        std::cout << "[INFO] Fetcher stopped. OK=" << ok_count_ << " ERR=" << err_count_ << "\n";
    }

private:
    static std::string env(const std::string& key, const std::string& fallback) {
        const char* v = std::getenv(key.c_str());
        return v ? v : fallback;
    }

    void log_tick(const std::string& price, const std::string& change_pct) {
        const auto now = std::chrono::system_clock::now();
        const auto tt = std::chrono::system_clock::to_time_t(now);
        auto* loc = std::localtime(&tt);
        std::cout << "[" << std::put_time(loc, "%Y-%m-%d %H:%M:%S") << "] "
                  << "BTC/USDT $" << price << " " << change_pct << "%"
                  << " [ok:" << ok_count_ << " err:" << err_count_ << "]\n";
    }

    PGconn* conn_ = nullptr;

    std::string db_host_;
    std::string db_port_;
    std::string db_user_;
    std::string db_pass_;
    std::string db_name_;

    int min_store_interval_ms_ = 1000;
    int reconnect_delay_sec_ = 5;

    uint64_t ok_count_ = 0;
    uint64_t err_count_ = 0;
    std::chrono::steady_clock::time_point last_store_time_{};
};

int main() {
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    std::cout << "=======================================\n"
              << " Binance BTC Price Fetcher (WebSocket)\n"
              << "=======================================\n";

    BinanceWsFetcher fetcher;
    fetcher.run();
    return 0;
}
