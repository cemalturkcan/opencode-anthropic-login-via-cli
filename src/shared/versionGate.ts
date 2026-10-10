import { getInstalledCliVersion, getIntro } from "./introspection.ts";
import { log } from "./logger.ts";
import { isVersionTooOld } from "./rateLimit.ts";

export async function reportVersionGate(response: Response): Promise<Response> {
  if (response.status !== 400) return response;
  const body = await response.clone().text();
  if (!isVersionTooOld(response.status, body)) return response;

  await log.error("anthropic rejected the reported claude code version", {
    reported: getIntro().version,
    installed: getInstalledCliVersion(),
    detail: body.slice(0, 500),
  });
  return response;
}
