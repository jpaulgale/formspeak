# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""FormSpeak telemetry dashboard — a clean local web view of voice sessions.

    uv run dashboard.py            # starts http://localhost:8787 and opens it

Reads the remote D1 through the already-authenticated `wrangler` CLI (no API
token). Click a session in the sidebar to replay the whole conversation as a
chat transcript — user/assistant bubbles, every tool call with its outcome, and
problems (errors, ws closes, unconfirmed fields) flagged in red. Stdlib only.
"""
import json
import subprocess
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

DB = "ramble-form-hackathon"
PORT = 8787


def query(sql: str) -> list[dict]:
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr or out.stdout)
    return json.loads(out.stdout)[0]["results"]


def sessions() -> list[dict]:
    # Skip single-event sessions: a lone session_start (or a bot's one-off hit) with no
    # real activity is just noise in the list, never a conversation worth replaying.
    return query(
        "SELECT session_id, submitted, event_count, country, region, city, colo, as_org, "
        "substr(ip_hash,1,10) AS ip_hash, started_at, last_seen "
        "FROM sessions WHERE event_count > 1 ORDER BY last_seen DESC LIMIT 500;"
    )


def session_detail(sid: str) -> dict:
    safe = sid.replace("'", "''")
    sess = query(f"SELECT * FROM sessions WHERE session_id = '{safe}';")
    events = query(
        f"SELECT seq, type, payload, client_ts FROM events "
        f"WHERE session_id = '{safe}' ORDER BY seq ASC;"
    )
    for e in events:
        try:
            e["data"] = json.loads(e.get("payload") or "{}")
        except json.JSONDecodeError:
            e["data"] = {}
        e.pop("payload", None)
    return {"session": sess[0] if sess else {"session_id": sid}, "events": events}


INDEX_HTML = r"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>FormSpeak — session telemetry</title>
<style>
  :root{
    --accent:#103FEF; --ink:#0a0a0a; --muted:#6b7280; --line:#e5e7eb;
    --bg:#f6f7f9; --card:#fff; --ok:#0a8f3c; --warn:#b06a00; --bad:#d11; --chip:#f1f3f7;
  }
  *{box-sizing:border-box;margin:0}
  body{font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    color:var(--ink);background:var(--bg);height:100vh;display:flex;overflow:hidden}
  /* sidebar */
  aside{width:340px;flex:none;border-right:1px solid var(--line);background:var(--card);
    display:flex;flex-direction:column;height:100vh}
  .head{padding:16px 16px 12px;border-bottom:1px solid var(--line)}
  .brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;letter-spacing:-.01em}
  .brand .dot{width:11px;height:11px;background:var(--accent);border-radius:2px}
  .sub{color:var(--muted);font-size:12px;margin-top:3px}
  .filters{display:flex;gap:6px;margin-top:12px}
  .filters button{flex:1;border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 0;
    font:inherit;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer}
  .filters button.on{background:var(--accent);border-color:var(--accent);color:#fff}
  .list{overflow-y:auto;flex:1}
  .row{padding:11px 16px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;gap:10px;align-items:flex-start}
  .row:hover{background:#fafbfc}
  .row.sel{background:#eef2ff;box-shadow:inset 3px 0 0 var(--accent)}
  .stat{width:9px;height:9px;border-radius:50%;margin-top:5px;flex:none;background:#cbd2dc}
  .stat.done{background:var(--ok)}
  .row .meta{min-width:0;flex:1}
  .row .top{display:flex;justify-content:space-between;gap:8px}
  .row .id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;font-size:12.5px}
  .row .when{color:var(--muted);font-size:11px;white-space:nowrap}
  .row .geo{color:var(--muted);font-size:12px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .n{color:var(--muted);font-size:11px;margin-top:2px}
  /* main */
  main{flex:1;display:flex;flex-direction:column;height:100vh;overflow:hidden}
  .mhead{padding:16px 22px;border-bottom:1px solid var(--line);background:var(--card)}
  .mhead h2{font-size:15px;font-weight:700;display:flex;align-items:center;gap:10px}
  .badge{font-size:11px;font-weight:700;padding:2px 9px;border-radius:99px}
  .badge.done{background:#e7f7ec;color:var(--ok)}
  .badge.no{background:#f1f3f7;color:var(--muted)}
  .mhead .line{color:var(--muted);font-size:12.5px;margin-top:5px;display:flex;flex-wrap:wrap;gap:4px 16px}
  .stream{overflow-y:auto;flex:1;padding:22px 22px 60px;background:var(--bg)}
  .empty{height:100%;display:grid;place-items:center;color:var(--muted);text-align:center;padding:40px}
  /* transcript */
  .bubble{max-width:74%;padding:9px 13px;border-radius:14px;margin:3px 0;white-space:pre-wrap;word-wrap:break-word}
  .turn{display:flex;margin:8px 0}
  .turn.user{justify-content:flex-end}
  .turn.user .bubble{background:var(--accent);color:#fff;border-bottom-right-radius:4px}
  .turn.asst .bubble{background:var(--card);border:1px solid var(--line);border-bottom-left-radius:4px}
  .who{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);
    margin:0 4px 1px;display:flex}
  .turn.user .who{justify-content:flex-end}
  /* tool call */
  .tool{display:flex;gap:9px;align-items:flex-start;margin:7px auto;max-width:88%;
    background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 12px}
  .tool .tick{font-size:14px;line-height:1.4;flex:none}
  .tool .body{min-width:0;flex:1}
  .tool .name{font-weight:700;font-size:12.5px}
  .tool .name b{font-family:ui-monospace,Menlo,monospace;color:var(--accent);font-weight:700}
  .tool .res{color:var(--muted);font-size:12px;margin-top:2px}
  .tool.ok{border-color:#bfe6cb}.tool.ok .tick{color:var(--ok)}
  .tool.warn{border-color:#f0dcae;background:#fffdf6}.tool.warn .tick{color:var(--warn)}
  .tool.bad{border-color:#f1c4c4;background:#fff7f7}.tool.bad .tick{color:var(--bad)}
  /* system notices */
  .sys{text-align:center;color:var(--muted);font-size:11.5px;margin:14px 0}
  .sys span{background:var(--chip);padding:3px 11px;border-radius:99px}
  .sys.bad span{background:#fdeaea;color:var(--bad);font-weight:600}
  .sys.start span{background:#eef2ff;color:var(--accent)}
  .sys.done span{background:#e7f7ec;color:var(--ok);font-weight:600}
  .refresh{margin-left:auto;border:1px solid var(--line);background:#fff;border-radius:8px;
    padding:5px 11px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;color:var(--muted)}
</style></head>
<body>
  <aside>
    <div class="head">
      <div class="brand"><span class="dot"></span>FormSpeak telemetry</div>
      <div class="sub" id="count">loading…</div>
      <div class="filters">
        <button data-f="all" class="on">All</button>
        <button data-f="abandoned">Didn’t submit</button>
        <button data-f="submitted">Submitted</button>
      </div>
    </div>
    <div class="list" id="list"></div>
  </aside>
  <main>
    <div class="mhead" id="mhead" style="display:none">
      <h2 id="mtitle"></h2>
      <div class="line" id="mmeta"></div>
    </div>
    <div class="stream" id="stream">
      <div class="empty">← Pick a session to replay its conversation.</div>
    </div>
  </main>
<script>
const $=s=>document.querySelector(s);
let ALL=[], FILTER="all", SEL=null;
const esc=s=>String(s??"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const ago=t=>t?String(t).replace("T"," ").slice(5,16):"";

async function load(){
  const r=await fetch("/api/sessions"); ALL=await r.json(); render();
}
function render(){
  const rows=ALL.filter(s=> FILTER==="all"?1: FILTER==="submitted"?s.submitted:!s.submitted);
  const done=ALL.filter(s=>s.submitted).length;
  $("#count").textContent=`${ALL.length} sessions · ${done} submitted · ${ALL.length-done} didn’t`;
  $("#list").innerHTML=rows.map(s=>{
    const geo=[s.city,s.region,s.country].filter(Boolean).join(", ")||"unknown";
    return `<div class="row ${s.session_id===SEL?'sel':''}" data-id="${s.session_id}">
      <div class="stat ${s.submitted?'done':''}"></div>
      <div class="meta">
        <div class="top"><span class="id">${s.session_id.slice(0,8)}</span><span class="when">${ago(s.last_seen)}</span></div>
        <div class="geo">${esc(geo)} · ${esc(s.colo||"")}</div>
        <div class="n">${s.event_count} events${s.as_org?" · "+esc(s.as_org):""}</div>
      </div></div>`;
  }).join("")||`<div class="empty">No sessions.</div>`;
  document.querySelectorAll(".row").forEach(r=>r.onclick=()=>open(r.dataset.id));
}
document.querySelectorAll(".filters button").forEach(b=>b.onclick=()=>{
  FILTER=b.dataset.f; document.querySelectorAll(".filters button").forEach(x=>x.classList.toggle("on",x===b)); render();
});

// classify a tool_call result string into ok / warn / bad
function verdict(t,res){
  const r=(res||"").toLowerCase();
  if(t==="submit_form"||/submit/.test(r)){
    if(/^submitted$/.test((res||"").trim().toLowerCase())) return "ok";
    if(/cannot submit|not confirmed|not all fields/.test(r)) return "bad";
  }
  if(/not confirmed|could not find|couldn'?t|cannot/.test(r)) return "bad";
  if(/ambiguous|closest matches|more than one|options/.test(r)) return "warn";
  if(/confirmed|accepted|saved|set to|ok/.test(r)) return "ok";
  return "warn";
}
const ICON={ok:"✓",warn:"⚠",bad:"✗"};

function open(id){
  SEL=id; render();
  fetch("/api/session/"+id).then(r=>r.json()).then(d=>draw(d));
  $("#stream").innerHTML=`<div class="empty">loading…</div>`;
}
function draw(d){
  const s=d.session||{}, ev=d.events||[];
  $("#mhead").style.display="block";
  $("#mtitle").innerHTML=`<span style="font-family:ui-monospace,Menlo,monospace">${(s.session_id||"").slice(0,8)}</span>`
    +(s.submitted?`<span class="badge done">submitted</span>`:`<span class="badge no">didn’t submit</span>`)
    +`<button class="refresh" onclick="open('${s.session_id}')">↻ refresh</button>`;
  const geo=[s.city,s.region,s.country].filter(Boolean).join(", ");
  $("#mmeta").innerHTML=[
    geo&&`📍 ${esc(geo)} (${esc(s.colo||"")})`,
    s.as_org&&`🏢 ${esc(s.as_org)}`,
    s.ip_hash&&`🔑 ${esc(String(s.ip_hash).slice(0,12))}`,
    `🕑 ${ago(s.started_at)} → ${ago(s.last_seen)}`,
    `${s.event_count||ev.length} events`,
    s.user_agent&&`🖥 ${esc(uaShort(s.user_agent))}`,
  ].filter(Boolean).map(x=>`<span>${x}</span>`).join("");

  let html="";
  for(const e of ev){
    const t=e.type, x=e.data||{};
    if(t==="session_start"){
      const bits=[x.resume?"resumed":"fresh start",x.lang,x.tz].filter(Boolean).join(" · ");
      html+=`<div class="sys start"><span>session started — ${esc(bits)}</span></div>`;
    }else if(t==="turn"){
      if(x.user) html+=bubble("user",x.user);
      if(x.asst) html+=bubble("asst",x.asst);
    }else if(t==="tool_call"){
      const v=verdict(x.name,x.result);
      const a=x.args||{};
      const label = x.name==="set_field"
        ? `set <b>${esc(a.field||"?")}</b> → “${esc(a.value??"")}”`
        : `<b>${esc(x.name)}</b>(${esc(Object.entries(a).map(([k,val])=>k+"="+JSON.stringify(val)).join(", "))})`;
      html+=`<div class="tool ${v}"><div class="tick">${ICON[v]}</div><div class="body">
        <div class="name">${label}</div>
        ${x.result?`<div class="res">${esc(x.result)}</div>`:""}</div></div>`;
    }else if(t==="ws_close"){
      const cls=(x.code===1000||x.code===1005)?"":"bad";
      html+=`<div class="sys ${cls}"><span>connection closed — code ${esc(x.code)}${x.reason?" · "+esc(x.reason):""}${x.shown?" · “"+esc(x.shown)+"”":""}</span></div>`;
    }else if(t==="ws_error"){
      html+=`<div class="sys bad"><span>websocket error</span></div>`;
    }else if(t==="error"){
      html+=`<div class="sys bad"><span>error (${esc(x.where||"")}) ${esc(x.name||"")} ${esc(x.message||"")}</span></div>`;
    }else if(t==="submit_saved"){
      html+=`<div class="sys done"><span>✓ submission saved to D1</span></div>`;
    }else if(t==="session_end"){
      const f=(x.filled||[]).length;
      html+=`<div class="sys"><span>session ended — ${f} field(s) filled${x.submitted?", submitted":""}</span></div>`;
    }else if(t==="ws_ready"){ /* quiet */ }
    else html+=`<div class="sys"><span>${esc(t)}</span></div>`;
  }
  $("#stream").innerHTML=html||`<div class="empty">No events.</div>`;
}
function bubble(who,text){
  return `<div class="turn ${who}"><div><div class="who">${who==="user"?"user":"FormSpeak"}</div>`
    +`<div class="bubble">${esc(text)}</div></div></div>`;
}
function uaShort(ua){
  const m=ua.match(/(iPhone|iPad|Android|Macintosh|Windows|Linux)/i);
  const b=ua.match(/(Chrome|Firefox|Safari|Edg)\/?\s*([\d.]+)?/i);
  return [m&&m[1].replace("Macintosh","Mac"), b&&b[1]].filter(Boolean).join(" · ")||"browser";
}
load();
</script>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/" or path == "/index.html":
                return self._send(200, INDEX_HTML, "text/html; charset=utf-8")
            if path == "/api/sessions":
                return self._send(200, json.dumps(sessions()))
            if path.startswith("/api/session/"):
                sid = path.rsplit("/", 1)[-1]
                return self._send(200, json.dumps(session_detail(sid)))
            self._send(404, json.dumps({"error": "not found"}))
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}))


def main() -> None:
    try:
        sessions()  # fail fast if wrangler/auth is broken
    except Exception as e:  # noqa: BLE001
        sys.exit(f"Couldn't read D1 via wrangler:\n{e}")
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"FormSpeak telemetry dashboard → {url}  (Ctrl-C to stop)")
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
