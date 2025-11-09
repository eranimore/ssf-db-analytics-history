import { renderHtml } from "./renderHtml";

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Handle POST requests to insert sessions
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      try {
        const body = await request.json() as SessionScheduleHistory;
        
        const stmt = env.DB.prepare(`
          INSERT INTO SESSIONS_SCHEDULE_HISTORY 
          (POOL_ID, UPDATED_AT, SESSION_DATE, SESSION_TIME, SESSION_DATETIME, SESSION_TITLE, SESSION_SIDE, AVAILABLE_SPOTS, AREA)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        const result = await stmt.bind(
          body.POOL_ID || null,
          body.UPDATED_AT || null,
          body.SESSION_DATE,
          body.SESSION_TIME,
          body.SESSION_DATETIME,
          body.SESSION_TITLE,
          body.SESSION_SIDE,
          body.AVAILABLE_SPOTS,
          body.AREA || null
        ).run();
        
        return new Response(JSON.stringify({ success: true, result }), {
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
      const stmt = env.DB.prepare("SELECT * FROM SESSIONS_SCHEDULE_HISTORY LIMIT 100");
      const { results } = await stmt.all();
      
      return new Response(JSON.stringify(results, null, 2), {
        headers: {
          "content-type": "application/json",
        },
      });
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
