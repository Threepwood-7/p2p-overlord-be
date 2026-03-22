import { randomUUID } from 'node:crypto';

import type { Handle, HandleFetch, HandleServerError } from '@sveltejs/kit';
import type { Logger } from 'winston';

import logger from '$lib/server/logger';

const log: Logger = logger.child({ module: 'hooks.server' });

/**
 * Records every inbound HTTP request with a request-scoped trace id.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const requestId = randomUUID();
	const startedAt = Date.now();
	const requestUrl = event.url.toString();
	event.locals.requestId = requestId;

	log.info('http_request_start', {
		request_id: requestId,
		method: event.request.method,
		url: requestUrl,
		route_id: event.route.id ?? null,
		remote_address: event.getClientAddress()
	});

	try {
		const response = await resolve(event);
		log.info('http_request_complete', {
			request_id: requestId,
			method: event.request.method,
			url: requestUrl,
			route_id: event.route.id ?? null,
			status: response.status,
			duration_ms: Date.now() - startedAt
		});
		return response;
	} catch (error) {
		log.error('http_request_failed', {
			request_id: requestId,
			method: event.request.method,
			url: requestUrl,
			route_id: event.route.id ?? null,
			duration_ms: Date.now() - startedAt,
			error
		});
		throw error;
	}
};

/**
 * Traces coordinator-to-agent HTTP calls, which are the critical control-plane hops.
 */
export const handleFetch: HandleFetch = async ({ event, request, fetch }) => {
	const startedAt = Date.now();
	const fetchId = randomUUID();

	log.debug('http_fetch_start', {
		request_id: event.locals.requestId ?? null,
		fetch_id: fetchId,
		method: request.method,
		url: request.url
	});

	try {
		const response = await fetch(request);
		log.debug('http_fetch_complete', {
			request_id: event.locals.requestId ?? null,
			fetch_id: fetchId,
			method: request.method,
			url: request.url,
			status: response.status,
			duration_ms: Date.now() - startedAt
		});
		return response;
	} catch (error) {
		log.error('http_fetch_failed', {
			request_id: event.locals.requestId ?? null,
			fetch_id: fetchId,
			method: request.method,
			url: request.url,
			duration_ms: Date.now() - startedAt,
			error
		});
		throw error;
	}
};

/**
 * Captures unhandled SvelteKit server errors in the permanent coordinator trace log.
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	log.error('http_unhandled_error', {
		request_id: event.locals.requestId ?? null,
		method: event.request.method,
		url: event.url.toString(),
		route_id: event.route.id ?? null,
		status,
		message,
		error
	});
};
