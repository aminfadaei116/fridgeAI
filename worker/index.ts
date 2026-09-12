import { Container } from "@cloudflare/containers";

interface Env {
  FRIDGE: DurableObjectNamespace<FridgeContainer>;
  // Set with `npx wrangler secret put <NAME>`. Absent unless configured, hence optional.
  LLM_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  BASE_URL_OVERRIDE?: string;
}

export class FridgeContainer extends Container<Env> {
  // Matches the port uvicorn binds in the Dockerfile. Requests are held until it listens.
  defaultPort = 8080;

  // The dashboard holds an SSE connection open (frontend/app.js:599), so an open tab keeps
  // the container awake by itself. Ten idle minutes after the last request it stops, and the
  // container disk stops with it - which means the SQLite fridge resets. Re-seed from the
  // dashboard's demo button. Raise this to keep state alive longer; it bills running time.
  sleepAfter = "10m";

  // Worker secrets are not visible to the container process, so hand them over explicitly.
  // pydantic-settings reads these straight off the environment, case-insensitively, which is
  // where backend/config.py expects to find them.
  //
  // Each is included only when actually set: an empty string would be worse than absent for
  // LLM_PROVIDER, whose Literal["openai", "gemini"] would reject it and fail startup.
  envVars = {
    ...(this.env.LLM_PROVIDER ? { LLM_PROVIDER: this.env.LLM_PROVIDER } : {}),
    ...(this.env.GEMINI_API_KEY ? { GEMINI_API_KEY: this.env.GEMINI_API_KEY } : {}),
    ...(this.env.OPENAI_API_KEY ? { OPENAI_API_KEY: this.env.OPENAI_API_KEY } : {}),
    ...(this.env.BASE_URL_OVERRIDE ? { BASE_URL_OVERRIDE: this.env.BASE_URL_OVERRIDE } : {}),
  };

  override onStart() {
    console.log("fridge container started");
  }

  override onStop() {
    console.log("fridge container stopped");
  }

  override onError(error: unknown) {
    console.error("fridge container error:", error);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Always the same single instance. FridgePipeline is a per-process singleton sitting on
    // SQLite and an in-memory event bus (backend/pipeline.py:33, backend/events.py), so a
    // second instance would be a second, divergent fridge with its own inventory.
    return env.FRIDGE.getByName("singleton").fetch(request);
  },
} satisfies ExportedHandler<Env>;
