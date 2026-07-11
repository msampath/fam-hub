"""FastAPI service exposing the concierge ADK agent over HTTP for the React surface.

KAGGLE_EVAL: Deployability + Security (per-request isolation). Each /chat call builds the agent graph with
the VISITOR's Supabase JWT (from `Authorization: Bearer`), so the MCP child persists ONLY under that
visitor's household (RLS-scoped) — the per-visitor isolation invariant from the security review. With no
token the agent still runs but writes are rejected (validate-only).

Contract (matches src/utils/agentClient.ts):
    POST /chat   { message, sessionId? }  + Authorization: Bearer <supabase-jwt>  ->  { reply, sessionId }
    GET  /healthz                                                                  ->  { ok: true }

Run locally (from the REPO ROOT, after `pip install -r agent/requirements.txt` + a Gemini key in env):
    uvicorn agent.api:app --host 0.0.0.0 --port 8080

ADK API note: targets google-adk >= 1.2 (Runner + InMemorySessionService + run_async). If your installed
ADK version's runner/session API differs, adjust the imports / call sites below.
"""
import asyncio
import base64
import datetime
import inspect
import json
import os
import traceback
from pathlib import Path

from dotenv import load_dotenv

# The repo uses ONE dotenv file: the repo-root `.env`. A bare `uvicorn agent.api:app` doesn't auto-load it, so
# load it here BEFORE importing the agent module (which reads COPILOT_MODEL at import time) — GEMINI_API_KEY /
# COPILOT_MODEL / SUPABASE_* all resolve from it. override=False → a real process env var still wins.
_AGENT_DIR = Path(__file__).resolve().parent
load_dotenv(_AGENT_DIR.parent / ".env", override=False)

# Don't make the user repeat the Gemini key: ADK reads GOOGLE_API_KEY, but the root .env already has it as
# GEMINI_API_KEY (for the Express app). Alias it so ONE key in the root .env powers both. (Real GOOGLE_API_KEY
# still wins — set above with override=False.)
if not os.environ.get("GOOGLE_API_KEY") and os.environ.get("GEMINI_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = os.environ["GEMINI_API_KEY"]
os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "FALSE")

# Fail boot LOUDLY on a key-less deploy (parity with the Express server's FATAL-exit), instead of passing the
# readiness probe and 502-ing every /chat. Skip when Vertex auth is used (it doesn't need an API key).
if os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "FALSE").upper() != "TRUE" and not os.environ.get("GOOGLE_API_KEY"):
    raise SystemExit("[concierge] FATAL: no GOOGLE_API_KEY / GEMINI_API_KEY set — the agent cannot call Gemini. Set one in agent/.env or the environment before starting.")

import time  # noqa: E402
from fastapi import FastAPI, Header, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from google.adk.runners import Runner  # noqa: E402
from google.adk.sessions import InMemorySessionService  # noqa: E402
from google.genai import types  # noqa: E402

from .concierge.agent import build_root_agent, FALLBACK_MODELS, MODEL  # noqa: E402
from .concierge.bridge import collect_actions  # noqa: E402
from .concierge.ratelimit import rate_ok, client_key_from_xff  # noqa: E402

APP_NAME = "concierge"

# Transient-capacity resilience (3c). Gemini flash models throw 503 UNAVAILABLE / 429 under load; a SINGLE
# attempt per model meant a brief spike took the concierge down (→ 502, local-fallback refusals). We now try
# each model in the chain a few times with short backoff before advancing. NOTE: this reduces fallbacks on
# *transient* spikes — it cannot fix a SUSTAINED Gemini capacity outage (the only real cure there is a model
# with quota). Env-overridable so latency vs. resilience can be tuned per deployment.
RETRYABLE_MARKERS = ("503", "UNAVAILABLE", "429", "RESOURCE_EXHAUSTED", "OVERLOADED")
MAX_ATTEMPTS_PER_MODEL = max(1, int(os.environ.get("CONCIERGE_MAX_ATTEMPTS", "2")))
RETRY_BACKOFF_BASE = float(os.environ.get("CONCIERGE_RETRY_BACKOFF", "0.6"))  # seconds; linear per attempt

# Local engine tier (Phase-4, Decision-B gated): CONCIERGE_LOCAL_ENABLED=1 inserts the local Ollama
# model (via ADK's LiteLLM wrapper) at the HEAD of the model chain. Gate before enabling anywhere real:
# `python agent/evals/run_eval.py` must show >=90% valid tool calls AND 0 destructive misfires on the
# local head. ANY local failure (refused connection, bad output, timeout) advances to the Gemini chain —
# the local tier can only ever ADD availability, never block a turn.
LOCAL_ENABLED = os.environ.get("CONCIERGE_LOCAL_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
LOCAL_MODEL = os.environ.get("CONCIERGE_LOCAL_MODEL", "ollama_chat/gpt-oss:20b")
LOCAL_TOKEN = "__local__"  # chain sentinel; resolved to a LiteLlm instance at build time


def build_model_chain() -> list:
    """The turn's model chain, in try-order: optional local head → primary (None → MODEL) → fallbacks."""
    return ([LOCAL_TOKEN] if LOCAL_ENABLED else []) + [None] + FALLBACK_MODELS

# Conversation history keyed by (user_id, session_id). The agent graph is rebuilt per request (it carries
# the visitor's token), but history is agent-independent, so it lives here and survives across turns.
_sessions = InMemorySessionService()

app = FastAPI(title="Family-Hub Concierge Agent")

# CORS for the React origin(s). Set ALLOWED_ORIGINS (comma-separated) in prod; "*" is the local-demo default.
_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


class ChatIn(BaseModel):
    message: str
    sessionId: str | None = None
    history: list[dict] | None = None   # recent local-copilot turns [{role, text}] for continuity on escalate
    family: str | None = None           # roster "Leo (8, Kid), Ava (5, Kid)" so the agent doesn't guess ages
    goals: list[dict] | None = None     # the family's CURRENT tracked goals [{id,text,status,nextAction,steps}]
    copilotName: str | None = None      # what the family calls the copilot (kid-pickable) — answer to it
    stores: list[str] | None = None     # household store lists (Phase-5) — route add_shopping_item to THESE
    mealplan: list[dict] | None = None  # the CURRENT week's dinners [{date,dish,note?}] — adjustment turns need it
    clientDate: str | None = None       # client's civil YYYY-MM-DD — avoids UTC drift on a UTC container


def _visitor_id(jwt: str | None) -> str:
    """Partition in-memory sessions per visitor. Decode the JWT's `sub` claim WITHOUT verifying — Supabase
    RLS in the MCP child does the real auth; this is only a session key. Falls back to 'anon' on any error.
    PUBLIC-DEPLOY HARDENING: verify the JWT signature here so a forged `sub` can't read
    another visitor's in-memory session history — needs the Supabase JWT secret / an auth verify call."""
    if not jwt:
        return "anon"
    try:
        payload = jwt.split(".")[1]
        payload += "=" * (-len(payload) % 4)  # pad base64url
        claims = json.loads(base64.urlsafe_b64decode(payload))
        return str(claims.get("sub") or "anon")
    except Exception:
        return "anon"


def _client_ip(request: Request) -> str:
    """Real client IP for the rate-limit key. Cloud Run appends it on the RIGHT of X-Forwarded-For (a
    client-supplied leftmost value is forgeable), so keying logic lives in client_key_from_xff — pure +
    unit-tested, matching the Node service's `trust proxy: 1`."""
    return client_key_from_xff(request.headers.get("x-forwarded-for", ""), request.client.host if request.client else None)


async def _close_agent(agent) -> None:
    """Best-effort shutdown of the per-request MCP stdio children (one per specialist) so we don't leak
    subprocesses. ADK toolsets expose an async close(); anything without one is ignored."""
    for sub in getattr(agent, "sub_agents", []) or []:
        for tool in getattr(sub, "tools", []) or []:
            close = getattr(tool, "close", None)
            if not callable(close):
                continue
            try:
                result = close()
                if inspect.isawaitable(result):
                    await result
            except Exception:
                pass


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.post("/chat")
async def chat(body: ChatIn, request: Request, authorization: str | None = Header(default=None)):
    if not rate_ok(_client_ip(request), time.monotonic()):
        raise HTTPException(status_code=429, detail="Too many requests — please slow down.")
    message = (body.message or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="A message is required.")

    jwt = None
    if authorization and authorization.lower().startswith("bearer "):
        jwt = authorization[7:].strip() or None
    user_id = _visitor_id(jwt)

    # Continue the conversation if a known sessionId was supplied; otherwise start a fresh one.
    session = None
    if body.sessionId:
        session = await _sessions.get_session(app_name=APP_NAME, user_id=user_id, session_id=body.sessionId)
    if session is None:
        session = await _sessions.create_session(app_name=APP_NAME, user_id=user_id)

    # Date-ground the request: the agent has no harness, so without this it resolves "next Saturday" / "Jul 4"
    # against the model's training bias (e.g. the wrong year). Prepend today's date so the tool-calling
    # specialist fills start_date in the CURRENT year. (The in-app copilot gets this via DATE FACTS.)
    # Now (date + LOCAL time) so a specialist resolves "next week" correctly AND knows how much of today
    # is left — the meal planner must not plan a meal for a day that's already mostly over (it planned
    # lunch for TODAY at 7:45 PM). %-I isn't portable (fails on Windows), so build the hour by hand.
    now = datetime.datetime.now()
    client_today: str | None = None
    if body.clientDate:
        try:
            today = datetime.date.fromisoformat(body.clientDate)
            client_today = body.clientDate
        except ValueError:
            today = now.date()
    else:
        today = now.date()
    _h12 = now.hour % 12 or 12
    time_label = f"{_h12}:{now.minute:02d} {'AM' if now.hour < 12 else 'PM'}"
    context = f"(Context: now is {now.strftime('%A')}, {today.isoformat()}, {time_label} local time. " \
              f"Resolve any relative or year-less dates from this; 'tomorrow' is the next calendar day."
    if body.family:
        # Use the REAL ages; never guess. DIETARY (when present) is BINDING for any food/meal/shopping
        # suggestion — a vegetarian/lacto-vegetarian household never gets meat, poultry, or fish.
        context += f" Family members: {body.family}. Use these exact ages — do not guess. Honor every " \
                   f"member's dietary restriction in any food, meal, or shopping suggestion (lacto-vegetarian " \
                   f"= no meat/poultry/fish but dairy is fine; only vegan drops dairy and egg)."
    if body.stores:
        # Household-defined store lists (Phase-5): clamp count+length; the shopping specialist routes
        # items to THESE names instead of the default Costco/Indian Store/Grocery Store/Other set.
        safe_stores = [" ".join(str(s).split())[:24] for s in body.stores[:8] if str(s).strip()]
        if safe_stores:
            context += f" The family's shopping store lists are exactly: {', '.join(safe_stores)}. Use these names for any store list."
    context += ")"
    # Carry the recent local-copilot conversation so an escalated turn hears the user's framing.
    convo = ""
    if body.history:
        # Bound each turn (a long prior copilot answer shouldn't balloon the agent prompt / token cost).
        turns = [f"{('Parent' if (h.get('role') == 'user') else 'Assistant')}: {str(h.get('text', ''))[:1000]}"
                 for h in body.history[-8:] if isinstance(h, dict) and h.get('text')]
        if turns:
            convo = "Recent conversation:\n" + "\n".join(turns) + "\n\n"
    # CURRENT GOALS — the family's tracked goals RIGHT NOW, injected every turn (the agent has no get_goals tool
    # and can't see goals it set on a PRIOR turn / a prior model's session). This is what lets it (a) reference
    # the right goal `id` to mark a step/goal done via set_goal, and (b) HONESTLY "recheck" by reading real state
    # instead of confabulating. Injected text rides in the grounded prompt, so it survives the fresh-session
    # model fallback (unlike server-side ADK session state). Bounded so the prompt stays small.
    goals_block = ""
    if body.goals:
        # Collapse whitespace/newlines in the injected fields so a goal title with a newline can't break the
        # block's one-line-per-goal structure (a thin guard — goals are the household's own, not web content).
        def _clean(v: object, n: int) -> str:
            return " ".join(str(v).split())[:n]
        lines = []
        for g in body.goals[:5]:
            if not isinstance(g, dict):
                continue
            steps = g.get("steps") or []
            step_str = "; ".join(
                f"{_clean(s.get('title', ''), 80)} [{_clean(s.get('status', 'pending'), 12)}]"
                for s in steps if isinstance(s, dict) and s.get("title")
            )
            gid = _clean(g.get("id", ""), 64)
            text = _clean(g.get("text", ""), 160)
            status = _clean(g.get("status", "active"), 16)
            lines.append(f'- id={gid} "{text}" (status: {status})' + (f" — steps: {step_str}" if step_str else ""))
        if lines:
            goals_block = (
                "CURRENT GOALS (the family's tracked goals RIGHT NOW — authoritative). To update or COMPLETE a "
                "goal or a step, call set_goal with THAT exact id and the new status; to 'recheck' a goal, read "
                "this block. NEVER say a goal/step was changed or completed unless you called set_goal this turn.\n"
                + "\n".join(lines) + "\n\n"
            )
    # CURRENT WEEK'S MEALS — same injection pattern as goals: an adjustment turn ("swap Thursday's
    # lunch to rajma") must re-issue set_meal_plan with the FULL updated week FOR THAT MEAL.
    meals_block = ""
    if body.mealplan:
        def _mclean(v: object, n: int) -> str:
            return " ".join(str(v).split())[:n]
        mlines = []
        for d in body.mealplan[:14]:
            if not isinstance(d, dict) or not d.get("date") or not d.get("dish"):
                continue
            meal = _mclean(d.get("meal") or "dinner", 10)
            note = f" ({_mclean(d.get('note'), 60)})" if d.get("note") else ""
            mlines.append(f"- {_mclean(d.get('date'), 10)} [{meal}]: {_mclean(d.get('dish'), 80)}{note}")
        if mlines:
            meals_block = (
                "CURRENT MEAL PLAN (this week, authoritative; [meal] labels each line). To change ANY day, "
                "call set_meal_plan with that SAME `meal` and the FULL updated week for it (it replaces per "
                "week+meal), and add only the new dish's missing ingredients.\n"
                + "\n".join(mlines) + "\n\n"
            )
    # Kid-pickable copilot name: one grounded line so every engine answers to the family's name for it.
    # Clamped + whitespace-collapsed (it's a household setting, not web content — thin guard only).
    name_block = ""
    if body.copilotName:
        safe_name = " ".join(str(body.copilotName).split())[:24]
        if safe_name and safe_name.lower() != "copilot":
            name_block = f'(The family named you "{safe_name}" — refer to yourself by that name.)\n\n'
    grounded = f"{context}\n\n{name_block}{goals_block}{meals_block}{convo}{message}"
    content = types.Content(role="user", parts=[types.Part(text=grounded)])

    async def _run_turn(model_name: str | None, turn_session_id: str):
        # Per-request agent carrying THIS visitor's token => the MCP child's writes are RLS-scoped to them.
        if model_name == LOCAL_TOKEN:
            # Lazy import: `litellm` is only required when the local tier is enabled.
            from google.adk.models.lite_llm import LiteLlm
            model_arg: object | None = LiteLlm(model=LOCAL_MODEL)
        else:
            model_arg = model_name
        agent = build_root_agent(access_token=jwt, model=model_arg, client_today=client_today)
        runner = Runner(app_name=APP_NAME, agent=agent, session_service=_sessions)
        reply = ""
        actions: list[dict] = []
        seen_actions: set = set()  # dedup tool results across events (some ADK versions re-emit on the final event)
        try:
            async for event in runner.run_async(user_id=user_id, session_id=turn_session_id, new_message=content):
                # Collect mutating tool results across the WHOLE run — the structured-action bridge for the bar.
                actions.extend(collect_actions(event, seen_actions))
                if event.is_final_response() and event.content and event.content.parts:
                    reply = "".join(p.text or "" for p in event.content.parts).strip()
        finally:
            await _close_agent(agent)
        return reply, actions

    # Try the model CHAIN (primary CONCIERGE_MODEL → each CONCIERGE_FALLBACK in order), each up to MAX_ATTEMPTS_PER_MODEL
    # times with linear backoff on a TRANSIENT capacity error (503/429/overloaded). A non-retryable error
    # aborts immediately. The FIRST attempt reuses the client's session (cross-turn continuity); every RETRY
    # runs on a FRESH session, because a 503 at a LATER tool-calling step leaves a partial tool exchange in the
    # session and reusing it would feed the retry a corrupted transcript. The successful attempt's session id
    # is returned for the next turn.
    # NOTE: the fresh-session-on-fallback drops the prior ADK transcript, so a fallback model loses the goal it
    # set earlier — but `grounded` (incl. the CURRENT GOALS block above) is rebuilt and re-sent on EVERY attempt,
    # so the goal's id + step statuses ride along regardless of which model/session answers. That's why the goal
    # state is injected as prompt text, not relied on from session memory. (Intentional; do not "fix" by reusing
    # the session on retry — see the corrupted-transcript reason above.)
    chain = build_model_chain()  # optional local head → primary (None → CONCIERGE_MODEL) → fallbacks
    last_err: Exception | None = None
    first = True
    for model_name in chain:
        label = LOCAL_MODEL if model_name == LOCAL_TOKEN else (model_name or "primary")
        for attempt in range(MAX_ATTEMPTS_PER_MODEL):
            if first:
                turn_session_id = session.id
                first = False
            else:
                turn_session_id = (await _sessions.create_session(app_name=APP_NAME, user_id=user_id)).id
            try:
                reply, actions = await _run_turn(model_name, turn_session_id)
                # Empty-reply backstop (found via the eval harness — a data-less briefing run ended with a
                # blank final message 3/3 times): never hand the family an empty bubble. Honest filler, no
                # invented content; the actions list (if any) still tells the real story.
                if not reply.strip():
                    reply = ("I couldn't put together an answer for that just now"
                             + (" — but the actions below did go through." if actions else " — mind trying again or rephrasing?"))
                # None = primary (CONCIERGE_MODEL); LOCAL_TOKEN = the local Ollama model; else the fallback.
                resolved_model = LOCAL_MODEL if model_name == LOCAL_TOKEN else (model_name or MODEL)
                if model_name == LOCAL_TOKEN:
                    print(f"[concierge] answered on LOCAL model {resolved_model!r}", flush=True)
                elif model_name is not None:
                    print(f"[concierge] answered on fallback model {resolved_model!r}", flush=True)
                return {"reply": reply, "sessionId": turn_session_id, "actions": actions, "model": resolved_model}
            except Exception as err:
                last_err = err
                if model_name == LOCAL_TOKEN:
                    # The local head must never block a turn: ANY failure (connection refused, litellm
                    # missing, bad tool syntax, timeout) advances straight to the cloud chain.
                    print(f"[concierge] local model failed ({err!r}); advancing to the cloud chain", flush=True)
                    break
                if not any(s in repr(err).upper() for s in RETRYABLE_MARKERS):
                    traceback.print_exc()  # real cause to the log; generic client message (F-06 parity)
                    raise HTTPException(status_code=502, detail="The agent could not complete that request.")
                print(f"[concierge] {label} attempt {attempt + 1}/{MAX_ATTEMPTS_PER_MODEL} transient failure ({err!r})", flush=True)
                if attempt + 1 < MAX_ATTEMPTS_PER_MODEL:
                    await asyncio.sleep(RETRY_BACKOFF_BASE * (attempt + 1))
        # exhausted this model's attempts on transient errors → fall through to the next model in the chain

    # The whole chain 503'd (sustained Gemini outage) — surface a 502 so the client degrades to the local copilot.
    if last_err is not None:
        print(f"[concierge] model chain exhausted on transient errors; last: {last_err!r}", flush=True)
    raise HTTPException(status_code=502, detail="The agent could not complete that request.")
