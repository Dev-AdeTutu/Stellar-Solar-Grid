/**
 * SolarGrid Alexa proxy (#904).
 *
 * Alexa Smart Home skills must be hosted on AWS Lambda. This function only
 * forwards requests to the SolarGrid backend, authenticated with a shared
 * secret; all logic lives in backend/src/lib/smartHomePlatforms.ts.
 *
 * Environment:
 *   BACKEND_URL          e.g. https://api.solargrid.example
 *   PROXY_SECRET         must equal SMART_HOME_ALEXA_PROXY_SECRET on the backend
 *   ALEXA_SKILL_ID       amzn1.ask.skill.… — rejects custom requests from other skills
 *
 * Trigger: add an "Alexa Smart Home" and an "Alexa Skills Kit" trigger, both
 * restricted to ALEXA_SKILL_ID.
 */
const TIMEOUT_MS = 7000;

async function forward(path, body) {
  const res = await fetch(`${process.env.BACKEND_URL}/api/smart-home/alexa/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Smart-Home-Proxy-Secret": process.env.PROXY_SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Backend responded ${res.status}`);
  return res.json();
}

function directiveError(event, type, message) {
  const header = event.directive.header;
  return {
    event: {
      header: {
        namespace: "Alexa",
        name: "ErrorResponse",
        payloadVersion: "3",
        messageId: crypto.randomUUID(),
        ...(header.correlationToken ? { correlationToken: header.correlationToken } : {}),
      },
      ...(event.directive.endpoint ? { endpoint: { endpointId: event.directive.endpoint.endpointId } } : {}),
      payload: { type, message },
    },
  };
}

export const handler = async (event) => {
  if (event.directive) {
    try {
      return await forward("directive", event);
    } catch (err) {
      console.error("directive forward failed", err);
      return directiveError(event, "BRIDGE_UNREACHABLE", "SolarGrid is temporarily unavailable");
    }
  }

  const appId = event.context?.System?.application?.applicationId ?? event.session?.application?.applicationId;
  if (process.env.ALEXA_SKILL_ID && appId !== process.env.ALEXA_SKILL_ID) {
    throw new Error("Request is not from the SolarGrid skill");
  }
  try {
    return await forward("custom", event);
  } catch (err) {
    console.error("custom forward failed", err);
    return {
      version: "1.0",
      response: {
        outputSpeech: { type: "PlainText", text: "Sorry, Solar Grid isn't reachable right now. Please try again in a moment." },
        shouldEndSession: true,
      },
    };
  }
};
