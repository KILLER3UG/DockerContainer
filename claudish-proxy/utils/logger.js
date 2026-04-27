let activityLog = [];
let requestLog = [];
let pendingRequests = new Map();

// ── Request/Response capture for debug inspector ──
const requestDetails = new Map(); // reqId -> { requestBody, responseBody, thinking, toolCalls, error }
const MAX_DETAILS = 20;

function logActivity(type, detail) {
    activityLog.unshift({
        time: new Date().toLocaleTimeString(),
        type: type,
        detail: detail
    });
    if (activityLog.length > 50) activityLog.pop();
}

function getActivityLog() {
    return activityLog;
}

// ── Request tracking for multi-client monitoring ──
function startRequest(info) {
    const id = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    pendingRequests.set(id, { ...info, startTime: Date.now() });
    return id;
}

function endRequest(id, result) {
    const start = pendingRequests.get(id);
    if (!start) return;
    pendingRequests.delete(id);

    const entry = {
        time: new Date().toLocaleTimeString(),
        clientType: start.clientType,
        endpoint: start.endpoint,
        model: result.model || start.model || 'unknown',
        status: result.status,
        durationMs: Date.now() - start.startTime,
        error: result.error || null,
        reqId: id
    };
    requestLog.unshift(entry);
    if (requestLog.length > 50) requestLog.pop();

    // Also store final result in details
    const details = requestDetails.get(id);
    if (details) {
        details.status = result.status;
        details.durationMs = entry.durationMs;
        if (result.error) details.error = result.error;
    }
}

function getRequestLog() {
    return requestLog;
}

function getPendingRequests() {
    return Array.from(pendingRequests.values()).map(r => ({
        clientType: r.clientType,
        endpoint: r.endpoint,
        model: r.model || 'unknown',
        elapsedMs: Date.now() - r.startTime
    }));
}

// ── Capture request/response details for debug inspector ──
function captureRequest(reqId, requestBody) {
    requestDetails.set(reqId, {
        reqId,
        timestamp: new Date().toLocaleTimeString(),
        requestBody: sanitizeForDisplay(requestBody),
        responseBody: null,
        thinking: null,
        toolCalls: null,
        finishReason: null,
        error: null,
        status: 'pending'
    });
    // Keep only last N
    if (requestDetails.size > MAX_DETAILS) {
        const firstKey = requestDetails.keys().next().value;
        requestDetails.delete(firstKey);
    }
}

function captureResponse(reqId, responseData) {
    const details = requestDetails.get(reqId);
    if (!details) return;
    details.responseBody = sanitizeForDisplay(responseData);
    details.status = 'completed';

    // Extract thinking/reasoning
    const choice = responseData.choices?.[0];
    const msg = choice?.message;
    if (msg?.reasoning || msg?.reasoning_content) {
        details.thinking = msg.reasoning || msg.reasoning_content;
    }
    if (msg?.tool_calls && msg.tool_calls.length > 0) {
        details.toolCalls = msg.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments
        }));
    }
    if (choice?.finish_reason) {
        details.finishReason = choice.finish_reason;
    }
}

function captureError(reqId, error) {
    const details = requestDetails.get(reqId);
    if (!details) return;
    details.error = error.message || String(error);
    details.status = 'error';
}

function getRequestDetails() {
    return Array.from(requestDetails.values()).reverse();
}

function getRequestDetail(reqId) {
    return requestDetails.get(reqId) || null;
}

// Sanitize sensitive data before storing/displaying
function sanitizeForDisplay(data) {
    if (!data) return data;
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    // Redact API keys
    return str.replace(/"(api[_-]?key|authorization|token)"\s*:\s*"[^"]*"/gi, '"$1": "***"');
}

module.exports = {
    logActivity, getActivityLog,
    startRequest, endRequest, getRequestLog, getPendingRequests,
    captureRequest, captureResponse, captureError, getRequestDetails, getRequestDetail
};
