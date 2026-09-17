import { renderHtml } from "./renderHtml";
import { seoContentForDatesHighlights } from "./ssf_seo_input_for_posts";
import { ingestMetrics, getMetricsData, renderMetricsDashboard } from "./ssf_metrics_dashboard";
import { daySnapshot } from "./ssf_day_snapshot";

interface SessionScheduleHistory {
  POOL_ID?: string | null;
  UPDATED_AT?: string | null;
  SESSION_DATE: string;
  SESSION_TIME: string;
  SESSION_DATETIME: string;
  SESSION_TITLE: string;
  SESSION_SIDE: 'LEFT' | 'RIGHT';
  AVAILABLE_SPOTS: number;
  AREA?: string | null;
}

// Matches METRICS_HISTORY's retention window (see ssf_metrics_dashboard.ts).
// At current volume (~10k rows/day combined across pools as of 2026-09) this
// keeps SESSIONS_SCHEDULE_HISTORY bounded to roughly a year's worth of rows
// steady-state instead of growing forever.
const SESSIONS_HISTORY_RETENTION_MONTHS = 12;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle POST requests to insert sessions
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      try {
        const body = await request.json() as SessionScheduleHistory[];
        
        // Validate array and limit
        if (!Array.isArray(body)) {
          return new Response(JSON.stringify({ success: false, error: "Request body must be an array" }), {
            status: 400,
            headers: {
              "content-type": "application/json",
            },
          });
        }
        
        if (body.length === 0) {
          return new Response(JSON.stringify({ success: false, error: "Array cannot be empty" }), {
            status: 400,
            headers: {
              "content-type": "application/json",
            },
          });
        }
        
        if (body.length > 1000) {
          return new Response(JSON.stringify({ success: false, error: "Maximum 1000 items allowed per request" }), {
            status: 400,
            headers: {
              "content-type": "application/json",
            },
          });
        }
        
        // Prepare batch insert statements
        const statements = body.map(session => {
          return env.DB.prepare(`
            INSERT INTO SESSIONS_SCHEDULE_HISTORY 
            (POOL_ID, UPDATED_AT, SESSION_DATE, SESSION_TIME, SESSION_DATETIME, SESSION_TITLE, SESSION_SIDE, AVAILABLE_SPOTS, AREA)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            session.POOL_ID || null,
            session.UPDATED_AT || null,
            session.SESSION_DATE,
            session.SESSION_TIME,
            session.SESSION_DATETIME,
            session.SESSION_TITLE,
            session.SESSION_SIDE,
            session.AVAILABLE_SPOTS,
            session.AREA || null
          );
        });
        
        // Prune rows past the retention window as part of the same batch, so
        // cleanup rides along with each ingest call and needs no separate
        // schedule (same approach as ingestMetrics in ssf_metrics_dashboard.ts).
        const retentionCutoff = new Date();
        retentionCutoff.setMonth(retentionCutoff.getMonth() - SESSIONS_HISTORY_RETENTION_MONTHS);
        statements.push(
          env.DB.prepare(`DELETE FROM SESSIONS_SCHEDULE_HISTORY WHERE UPDATED_AT < ?`).bind(retentionCutoff.toISOString())
        );

        // Execute batch insert
        const results = await env.DB.batch(statements);

        return new Response(JSON.stringify({
          success: true,
          inserted: body.length,
          results
        }), {
          status: 201,
          headers: {
            "content-type": "application/json",
          },
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: String(error) }), {
          status: 400,
          headers: {
            "content-type": "application/json",
          },
        });
      }
    }
    
    // Handle GET requests to view sessions
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      const stmt = env.DB.prepare("SELECT * FROM SESSIONS_SCHEDULE_HISTORY ORDER BY SESSION_DATETIME DESC LIMIT 1000");
      const { results } = await stmt.all();
      
      return new Response(JSON.stringify(results, null, 2), {
        headers: {
          "content-type": "application/json",
        },
      });
    }
    
    // Handle GET requests for SEO content - dates vacancies
    if (request.method === "GET" && url.pathname === "/api/ssf-seo-post-content/dates-vacancies") {
      return await seoContentForDatesHighlights(request, env);
    }

    // Handle GET requests for a pool's session snapshot on past dates (KV cached)
    if (request.method === "GET" && url.pathname === "/api/sessions/day-snapshot") {
      return await daySnapshot(request, env, ctx);
    }

    // Handle metrics ingestion (replaces the CloudWatch push) and dashboard
    if (request.method === "POST" && url.pathname === "/api/metrics/ingest") {
      return await ingestMetrics(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/metrics/data") {
      return await getMetricsData(request, env);
    }

    if (request.method === "GET" && url.pathname === "/dashboard") {
      return await renderMetricsDashboard();
    }

    if (request.method === "GET" && url.pathname === "/metrics_dashboard_client.js") {
      return await env.ASSETS.fetch(request);
    }

    // Default: show comments
    const stmt = env.DB.prepare("SELECT * FROM comments LIMIT 3");
    const { results } = await stmt.all();

    return new Response(renderHtml(JSON.stringify(results, null, 2)), {
      headers: {
        "content-type": "text/html",
      },
    });
  },
} satisfies ExportedHandler<Env>;
