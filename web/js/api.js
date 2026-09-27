/**
 * The only place that talks to the server.
 *
 * Two rules keep the client honest:
 *  - Every error is an RFC 9457 problem document, so one `ApiError` type carries
 *    the machine-readable code *and* the structured detail (a cycle's path, a
 *    validation issue list). The UI branches on `code`, never on prose.
 *  - Mutations return the whole board. The client replaces its state instead of
 *    patching it, so it can never disagree with the server's schedule.
 */

export class ApiError extends Error {
  /** @param {Record<string, any>} problem */
  constructor(problem) {
    super(problem.detail ?? problem.title ?? 'Request failed');
    this.name = 'ApiError';
    this.code = problem.code ?? 'INTERNAL';
    this.status = problem.status ?? 500;
    this.title = problem.title ?? 'Request failed';
    this.problem = problem;
  }
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, headers?: Record<string,string> }} [options]
 */
async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    // Network-level failure: the server is down or the tab is offline. This is
    // distinct from a rejection, and the UI says so.
    throw new ApiError({
      code: 'NETWORK',
      status: 0,
      title: 'Cannot reach the server',
      detail: 'The request never left the browser. Check that the server is running.',
      cause: String(cause),
    });
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      payload ?? {
        status: response.status,
        title: `HTTP ${response.status}`,
        detail: text.slice(0, 300),
      },
    );
  }
  return payload;
}

export const api = {
  board: () => request('/api/board'),
  health: () => request('/api/health'),
  audit: (limit = 30) => request(`/api/audit?limit=${limit}`),

  createTask: (input) => request('/api/tasks', { method: 'POST', body: input }),
  updateTask: (id, input) => request(`/api/tasks/${id}`, { method: 'PATCH', body: input }),
  moveTask: (id, input) => request(`/api/tasks/${id}/move`, { method: 'POST', body: input }),
  deleteTask: (id) => request(`/api/tasks/${id}`, { method: 'DELETE' }),

  addDependency: (input) => request('/api/dependencies', { method: 'POST', body: input }),
  removeDependency: (id) => request(`/api/dependencies/${id}`, { method: 'DELETE' }),

  suggestions: () => request('/api/ai/suggestions'),
  suggest: () => request('/api/ai/suggest-dependencies', { method: 'POST' }),
  acceptSuggestion: (id) => request(`/api/ai/suggestions/${id}/accept`, { method: 'POST' }),
  rejectSuggestion: (id) => request(`/api/ai/suggestions/${id}/reject`, { method: 'POST' }),
  whatIf: (taskId, durationDays) =>
    request('/api/ai/explain-impact', { method: 'POST', body: { taskId, durationDays } }),

  resetDemo: (token) =>
    request('/api/admin/reset-demo', {
      method: 'POST',
      headers: token ? { 'x-admin-token': token } : {},
    }),
};
