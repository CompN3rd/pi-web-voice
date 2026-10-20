import { PI_WEB_HOST_PI_SESSIONS_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY } from "@jmfederico/pi-web/server-plugin-api";
import type { PiWebServerPlugin, JsonValue } from "@jmfederico/pi-web/server-plugin-api";
import { record } from "./protocol.ts";
import { exchangeSdp } from "./realtime.ts";
import { VoiceService } from "./server/service.ts";
import { Store } from "./server/store.ts";

export default {
  apiVersion: 3, name: "Voice",
  requires: [PI_WEB_HOST_PI_SESSIONS_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY],
  activate(host) {
    let service: VoiceService | undefined;
    let attempts: number[] = [];
    return {
      start({ capabilities }) { service = new VoiceService(new Store(host.dataDirectory), capabilities.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY), capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY), host.lifetimeSignal); },
      peer: { async request(context) {
        context.signal.throwIfAborted(); host.lifetimeSignal.throwIfAborted();
        if (!service) throw new Error("Voice backend not ready");
        const scope = { projectId: context.project.id, workspaceId: context.workspace.id };
        let result: unknown;
        switch (context.operation) {
          case "connect": {
            attempts = attempts.filter(t => t > Date.now() - 60_000);
            if (attempts.length >= 4) throw new Error("Voice connection limit: wait a minute before reconnecting");
            attempts.push(Date.now());
            result = await exchangeSdp(context.input, host.settings, AbortSignal.any([context.signal, host.lifetimeSignal])); break;
          }
          case "list": {
            const workers = await service.list(scope);
            // List metadata only: full results are opt-in, individually bounded reads.
            result = workers.map(w => ({ ...w, text: "", ...(w.question ? { question: "Input requested; read worker for details." } : {}) })); break;
          }
          case "read": {
            const id = record(context.input).workerId;
            const workers = await service.list(scope);
            const worker = workers.find(w => w.id === id);
            if (!worker) throw new Error("Unknown worker in this workspace");
            result = worker; break;
          }
          case "models": result = await service.models(scope, record(context.input).sessionId); break;
          case "arm": result = service.arm(scope, record(context.input).count); break;
          case "disarm": service.disarm(scope, record(context.input).token); result = { ok: true }; break;
          case "execute": result = await service.execute(scope, context.input); break;
          default: throw new Error("Unsupported voice operation");
        }
        return result as JsonValue;
      } },
      async dispose() { await service?.dispose(); service = undefined; },
      health() { return service ? { status: "healthy" as const } : { status: "unhealthy" as const }; },
    };
  },
} satisfies PiWebServerPlugin;
