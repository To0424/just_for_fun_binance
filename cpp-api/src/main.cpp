/*
 * Binance REST API Server
 * -----------------------
 * Lightweight C++ HTTP server that queries PostgreSQL for stored BTC/USDT
 * price data and serves it as JSON to the frontend dashboard.
 *
 * Technologies: C++17, cpp-httplib, libpq, nlohmann/json
 */

#include <iostream>
#include <string>
#include <cstdlib>
#include <sstream>

#include <libpq-fe.h>
#include <nlohmann/json.hpp>
#include <httplib.h>

using json = nlohmann::json;

// ── Helpers ────────────────────────────────────────────────────────────────
static std::string env(const std::string& key, const std::string& fallback) {
    const char* v = std::getenv(key.c_str());
    return v ? v : fallback;
}

static void cors(httplib::Response& res) {
    res.set_header("Access-Control-Allow-Origin",  "*");
    res.set_header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set_header("Access-Control-Allow-Headers", "*");
}

// ── Simple RAII wrapper for PGconn ─────────────────────────────────────────
class PgConn {
public:
    explicit PgConn(const std::string& conninfo)
        : conn_(PQconnectdb(conninfo.c_str())) {}

    ~PgConn() { if (conn_) PQfinish(conn_); }

    bool ok() const { return conn_ && PQstatus(conn_) == CONNECTION_OK; }
    PGconn* get() const { return conn_; }

    PgConn(const PgConn&) = delete;
    PgConn& operator=(const PgConn&) = delete;
private:
    PGconn* conn_;
};

// ── Simple RAII wrapper for PGresult ───────────────────────────────────────
class PgResult {
public:
    explicit PgResult(PGresult* r) : res_(r) {}
    ~PgResult() { if (res_) PQclear(res_); }

    bool ok()   const { return PQresultStatus(res_) == PGRES_TUPLES_OK; }
    int  rows() const { return PQntuples(res_); }
    const char* val(int row, int col) const { return PQgetvalue(res_, row, col); }

    PgResult(const PgResult&) = delete;
    PgResult& operator=(const PgResult&) = delete;
private:
    PGresult* res_;
};

// ════════════════════════════════════════════════════════════════════════════
static std::string g_conninfo;   // shared connection string

// Map range string → PostgreSQL interval
static std::string range_to_interval(const std::string& range) {
    if (range == "1h")  return "1 hour";
    if (range == "6h")  return "6 hours";
    if (range == "24h") return "24 hours";
    if (range == "7d")  return "7 days";
    if (range == "30d") return "30 days";
    return "1 hour";
}

// ════════════════════════════════════════════════════════════════════════════
int main() {
    // Read configuration
    std::string db_host = env("DB_HOST", "localhost");
    std::string db_port = env("DB_PORT", "5432");
    std::string db_user = env("DB_USER", "admin");
    std::string db_pass = env("DB_PASSWORD", "admin123");
    std::string db_name = env("DB_NAME", "binance_db");
    int api_port        = std::stoi(env("API_PORT", "8080"));

    g_conninfo = "host=" + db_host + " port=" + db_port +
                 " user=" + db_user + " password=" + db_pass +
                 " dbname=" + db_name;

    // Verify database connectivity at startup
    {
        PgConn test(g_conninfo);
        if (!test.ok()) {
            std::cerr << "[FATAL] Cannot connect to database.\n";
            return 1;
        }
        std::cout << "[INFO] Database connection verified.\n";
    }

    httplib::Server svr;

    // ── CORS preflight ─────────────────────────────────────────────────────
    svr.Options(R"(.*)", [](const httplib::Request&, httplib::Response& res) {
        cors(res);
        res.status = 204;
    });

    // ── GET /api/health ────────────────────────────────────────────────────
    svr.Get("/api/health", [](const httplib::Request&, httplib::Response& res) {
        cors(res);
        json body = {{"status", "ok"}, {"service", "binance-cpp-api"}};
        res.set_content(body.dump(), "application/json");
    });

    // ── GET /api/latest ────────────────────────────────────────────────────
    svr.Get("/api/latest", [](const httplib::Request&, httplib::Response& res) {
        cors(res);
        PgConn db(g_conninfo);
        if (!db.ok()) {
            res.status = 500;
            res.set_content(R"({"error":"db connection failed"})", "application/json");
            return;
        }

        PgResult r(PQexec(db.get(),
            "SELECT id, symbol, price, high_24h, low_24h, volume_24h, "
            "price_change_pct, to_char(timestamp AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') AS ts "
            "FROM btc_prices ORDER BY timestamp DESC LIMIT 1"));

        if (!r.ok() || r.rows() == 0) {
            res.status = 404;
            res.set_content(R"({"error":"no data"})", "application/json");
            return;
        }

        json body = {
            {"id",               std::stoi(r.val(0, 0))},
            {"symbol",           r.val(0, 1)},
            {"price",            r.val(0, 2)},
            {"high_24h",         r.val(0, 3)},
            {"low_24h",          r.val(0, 4)},
            {"volume_24h",       r.val(0, 5)},
            {"price_change_pct", r.val(0, 6)},
            {"timestamp",        r.val(0, 7)}
        };
        res.set_content(body.dump(), "application/json");
    });

    // ── GET /api/prices?range=1h ───────────────────────────────────────────
    svr.Get("/api/prices", [](const httplib::Request& req, httplib::Response& res) {
        cors(res);
        PgConn db(g_conninfo);
        if (!db.ok()) {
            res.status = 500;
            res.set_content(R"({"error":"db connection failed"})", "application/json");
            return;
        }

        std::string range = req.get_param_value("range");
        if (range.empty()) range = "1h";
        std::string interval = range_to_interval(range);

        // Down-sample to at most ~500 points for large ranges
        int max_pts = 500;
        std::string sql =
            "SELECT price, high_24h, low_24h, volume_24h, price_change_pct, "
            "to_char(timestamp AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS') AS ts "
            "FROM ("
            "  SELECT *, ROW_NUMBER() OVER (ORDER BY timestamp ASC) AS rn, "
            "  COUNT(*) OVER () AS total "
            "  FROM btc_prices "
            "  WHERE timestamp > NOW() - INTERVAL '" + interval + "'"
            ") sub "
            "WHERE rn % GREATEST(1, total / " + std::to_string(max_pts) + ") = 0 "
            "ORDER BY ts ASC";

        PgResult r(PQexec(db.get(), sql.c_str()));
        if (!r.ok()) {
            res.status = 500;
            res.set_content(R"({"error":"query failed"})", "application/json");
            return;
        }

        json prices = json::array();
        for (int i = 0; i < r.rows(); ++i) {
            prices.push_back({
                {"price",            r.val(i, 0)},
                {"high_24h",         r.val(i, 1)},
                {"low_24h",          r.val(i, 2)},
                {"volume_24h",       r.val(i, 3)},
                {"price_change_pct", r.val(i, 4)},
                {"timestamp",        r.val(i, 5)}
            });
        }

        json body = {{"range", range}, {"count", r.rows()}, {"prices", prices}};
        res.set_content(body.dump(), "application/json");
    });

    // ── GET /api/stats?range=24h ───────────────────────────────────────────
    svr.Get("/api/stats", [](const httplib::Request& req, httplib::Response& res) {
        cors(res);
        PgConn db(g_conninfo);
        if (!db.ok()) {
            res.status = 500;
            res.set_content(R"({"error":"db connection failed"})", "application/json");
            return;
        }

        std::string range = req.get_param_value("range");
        if (range.empty()) range = "24h";
        std::string interval = range_to_interval(range);

        std::string sql =
            "SELECT "
            "  MIN(price)  AS min_price, "
            "  MAX(price)  AS max_price, "
            "  AVG(price)  AS avg_price, "
            "  COUNT(*)    AS data_points, "
            "  (SELECT price FROM btc_prices "
            "   WHERE timestamp > NOW() - INTERVAL '" + interval + "' "
            "   ORDER BY timestamp ASC LIMIT 1) AS open_price, "
            "  (SELECT price FROM btc_prices "
            "   ORDER BY timestamp DESC LIMIT 1) AS close_price "
            "FROM btc_prices "
            "WHERE timestamp > NOW() - INTERVAL '" + interval + "'";

        PgResult r(PQexec(db.get(), sql.c_str()));
        if (!r.ok() || r.rows() == 0) {
            res.status = 500;
            res.set_content(R"({"error":"stats query failed"})", "application/json");
            return;
        }

        json body = {
            {"range",       range},
            {"min_price",   r.val(0, 0) ? r.val(0, 0) : "0"},
            {"max_price",   r.val(0, 1) ? r.val(0, 1) : "0"},
            {"avg_price",   r.val(0, 2) ? r.val(0, 2) : "0"},
            {"data_points", r.val(0, 3) ? std::stoi(r.val(0, 3)) : 0},
            {"open_price",  r.val(0, 4) ? r.val(0, 4) : "0"},
            {"close_price", r.val(0, 5) ? r.val(0, 5) : "0"}
        };
        res.set_content(body.dump(), "application/json");
    });

    // ── Start server ───────────────────────────────────────────────────────
    std::cout << "╔══════════════════════════════════════╗\n"
              << "║  Binance REST API Server   (C++17)   ║\n"
              << "║  Listening on port " << api_port << "              ║\n"
              << "╚══════════════════════════════════════╝\n";

    svr.listen("0.0.0.0", api_port);
    return 0;
}
