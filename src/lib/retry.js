export const RETRY_POLICY = Object.freeze({
  attempts: 4,
  delaysMs: Object.freeze([350, 800, 1_600]),
});

class RetryableHttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.name = 'RetryableHttpError';
    this.status = status;
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableNetworkError(error) {
  if (error instanceof RetryableHttpError) return true;
  const name = String(error?.name || '');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const code = String(error?.code || error?.cause?.code || '');
  const message = `${error?.message || ''} ${error?.cause?.message || ''}`;
  return /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENET(?:UNREACH|DOWN)|EHOSTUNREACH|UND_ERR|socket|fetch failed|network|connection (?:was )?(?:closed|reset)|other side closed|terminated/i.test(
    `${code} ${message}`
  );
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function exhaustedError(label, retryCount, cause) {
  const status = cause instanceof RetryableHttpError ? `（HTTP ${cause.status}）` : '';
  const error = new Error(`${label}失败，已自动重试 ${retryCount} 次${status}，请稍后再试`);
  error.name = 'RetryExhaustedError';
  error.cause = cause;
  return error;
}

/**
 * Fetches an idempotent upstream resource with bounded retries.
 * When consume is supplied, response-body failures are retried as part of the same attempt.
 */
export async function fetchWithRetry(input, init = {}, options = {}) {
  const attempts = Math.max(1, Number.parseInt(options.attempts, 10) || RETRY_POLICY.attempts);
  const delaysMs = Array.isArray(options.delaysMs) && options.delaysMs.length
    ? options.delaysMs.map((value) => Math.max(0, Number(value) || 0))
    : RETRY_POLICY.delaysMs;
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 20_000);
  const label = String(options.label || '连接上游服务');
  const consume = typeof options.consume === 'function' ? options.consume : null;
  const callerSignal = init.signal;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (callerSignal?.aborted) throw callerSignal.reason || new DOMException('Aborted', 'AbortError');

    const controller = new AbortController();
    let timedOut = false;
    const relayAbort = () => controller.abort(callerSignal.reason);
    callerSignal?.addEventListener('abort', relayAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (isRetryableStatus(response.status)) {
        try { await response.body?.cancel(); } catch {}
        throw new RetryableHttpError(response.status);
      }
      return consume ? await consume(response) : response;
    } catch (error) {
      if (callerSignal?.aborted) throw error;
      if (!timedOut && !isRetryableNetworkError(error)) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', relayAbort);
    }

    if (attempt === attempts) {
      recordDiagnostic('error', 'upstream.retry_exhausted', `${label}重试耗尽`, { retries: attempts - 1 });
      throw exhaustedError(label, attempts - 1, lastError);
    }
    const waitMs = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
    recordDiagnostic('warn', 'upstream.retry', `${label}将在短暂等待后重试`, {
      attempt,
      maxAttempts: attempts,
      waitMs,
      status: lastError?.status,
    });
    if (typeof options.onRetry === 'function') {
      options.onRetry({ attempt, maxAttempts: attempts, waitMs, error: lastError });
    }
    await delay(waitMs, callerSignal);
  }

  throw exhaustedError(label, attempts - 1, lastError);
}
import { recordDiagnostic } from './diagnostics.js';
