import type { AcquisitionFailureCode } from "@andvl1/omp-workflows-core";

/**
 * Provider-side failures carry only a deterministic category and safe metadata.
 * Never attach response bodies, request URLs containing credentials, or headers.
 */
export class AcquisitionProviderError extends Error {
  readonly code: AcquisitionFailureCode;
  readonly retryable: boolean;
  readonly provider: string;
  readonly status?: number;

  constructor(
    code: AcquisitionFailureCode,
    message: string,
    options: { provider: string; retryable?: boolean; status?: number },
  ) {
    super(message);
    this.name = "AcquisitionProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.provider = options.provider;
    this.status = options.status;
  }
}

export function isAcquisitionProviderError(value: unknown): value is AcquisitionProviderError {
  return value instanceof AcquisitionProviderError;
}

/** Read a response once and enforce the configured UTF-8 byte cap. */
export async function readBoundedResponseText(response: Response, maxBytes: number, provider: string): Promise<string> {
  const body = response.body;
  if (!body) {
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new AcquisitionProviderError("NETWORK_ERROR", "provider response could not be read", {
        provider,
        retryable: true,
        status: response.status,
      });
    }
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new AcquisitionProviderError("LIMIT_EXCEEDED", "provider response exceeded the configured byte limit", {
        provider,
        retryable: false,
        status: response.status,
      });
    }
    return text;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    throw new AcquisitionProviderError("NETWORK_ERROR", "provider response could not be read", {
      provider,
      retryable: true,
      status: response.status,
    });
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is best effort; preserve the sanitized limit error below.
        }
        throw new AcquisitionProviderError("LIMIT_EXCEEDED", "provider response exceeded the configured byte limit", {
          provider,
          retryable: false,
          status: response.status,
        });
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof AcquisitionProviderError) throw error;
    throw new AcquisitionProviderError("NETWORK_ERROR", "provider response could not be read", {
      provider,
      retryable: true,
      status: response.status,
    });
  }

  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/** Classify HTTP status without retaining or exposing provider payloads. */
export function classifyProviderHttpStatus(
  provider: string,
  status: number,
  bodyHint = "",
  options: { notFoundCode?: AcquisitionFailureCode; forbiddenCode?: AcquisitionFailureCode } = {},
): AcquisitionProviderError {
  const hint = bodyHint.toLowerCase();
  if (status === 401 || /invalid[_ -]?key|invalid[_ -]?credential|api[_ -]?key/i.test(hint)) {
    return new AcquisitionProviderError("PROVIDER_AUTH_MISSING", "provider authorization is unavailable", {
      provider,
      retryable: false,
      status,
    });
  }
  if (status === 429 || /quota|rate.?limit|daily.?limit/i.test(hint)) {
    return new AcquisitionProviderError("QUOTA_EXCEEDED", "provider quota or rate limit was exceeded", {
      provider,
      retryable: false,
      status,
    });
  }
  if (status === 408 || status === 504) {
    return new AcquisitionProviderError("PROVIDER_TIMEOUT", "provider request timed out", {
      provider,
      retryable: true,
      status,
    });
  }
  if (status === 404) {
    return new AcquisitionProviderError(options.notFoundCode ?? "MEDIA_NOT_ACCESSIBLE", "provider source was not found", {
      provider,
      retryable: false,
      status,
    });
  }
  if (status === 403) {
    return new AcquisitionProviderError(options.forbiddenCode ?? "MEDIA_NOT_ACCESSIBLE", "provider refused public source analysis", {
      provider,
      retryable: false,
      status,
    });
  }
  if (status >= 500) {
    return new AcquisitionProviderError("NETWORK_ERROR", "provider service is unavailable", {
      provider,
      retryable: true,
      status,
    });
  }
  return new AcquisitionProviderError("NETWORK_ERROR", "provider request failed", {
    provider,
    retryable: status >= 400,
    status,
  });
}

export function safeProviderError(
  provider: string,
  error: unknown,
): AcquisitionProviderError {
  if (isAcquisitionProviderError(error)) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new AcquisitionProviderError("PROVIDER_TIMEOUT", "provider request timed out", {
      provider,
      retryable: true,
    });
  }
  return new AcquisitionProviderError("NETWORK_ERROR", "provider request could not be completed", {
    provider,
    retryable: true,
  });
}
