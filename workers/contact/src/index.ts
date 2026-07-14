const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_MAIL = 'urn:ietf:params:jmap:mail';
const JMAP_SUBMISSION = 'urn:ietf:params:jmap:submission';
const FASTMAIL_SESSION_URL = 'https://api.fastmail.com/jmap/session';
const MAX_BODY_LENGTH = 16_384;

type Contact = {
	name: string;
	email: string;
	message: string;
	token: string;
};

type TurnstileResult = {
	success?: boolean;
	hostname?: string;
	action?: string;
};

type FastmailSession = {
	apiUrl?: string;
	primaryAccounts?: Record<string, string>;
};

type Identity = {
	id: string;
	name?: string;
	email: string;
};

type Mailbox = {
	id: string;
	role?: string | null;
};

type JmapResponse = {
	methodResponses?: Array<[string, Record<string, unknown>, string]>;
};

class ContactError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		readonly publicMessage: string,
	) {
		super(code);
	}
}

function splitList(value: string): Set<string> {
	return new Set(value.split(',').map((item) => item.trim()).filter(Boolean));
}

function isAllowedOrigin(origin: string | null, env: Env): origin is string {
	return typeof origin === 'string' && splitList(env.ALLOWED_ORIGINS).has(origin);
}

function responseHeaders(origin: string | null, env: Env): HeadersInit {
	const headers: Record<string, string> = {
		'Cache-Control': 'no-store',
		'Content-Type': 'application/json; charset=utf-8',
		'X-Content-Type-Options': 'nosniff',
		Vary: 'Origin',
	};

	if (isAllowedOrigin(origin, env)) {
		headers['Access-Control-Allow-Origin'] = origin;
		headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
		headers['Access-Control-Allow-Headers'] = 'Content-Type';
		headers['Access-Control-Max-Age'] = '86400';
	}

	return headers;
}

function json(body: unknown, status: number, origin: string | null, env: Env): Response {
	return Response.json(body, { status, headers: responseHeaders(origin, env) });
}

async function readBody(request: Request): Promise<string | null> {
	const declaredLength = Number(request.headers.get('Content-Length'));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_LENGTH) {
		return null;
	}

	if (!request.body) return '';

	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let totalLength = 0;
	let body = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		totalLength += value.byteLength;
		if (totalLength > MAX_BODY_LENGTH) {
			await reader.cancel();
			return null;
		}

		body += decoder.decode(value, { stream: true });
	}

	return body + decoder.decode();
}

function cleanSingleLine(value: unknown): string {
	return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function cleanMessage(value: unknown): string {
	return typeof value === 'string' ? value.trim().replace(/\r\n?/g, '\n') : '';
}

function isEmail(value: string): boolean {
	return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseContact(raw: unknown): Contact {
	if (!raw || typeof raw !== 'object') {
		throw new ContactError('invalid-form', 400, 'Check the form and try again.');
	}

	const data = raw as Record<string, unknown>;
	const name = cleanSingleLine(data.name);
	const email = cleanSingleLine(data.email).toLowerCase();
	const message = cleanMessage(data.message);
	const token = typeof data.token === 'string' ? data.token.trim() : '';

	if (
		!name ||
		name.length > 100 ||
		!isEmail(email) ||
		email.length > 254 ||
		!message ||
		message.length > 5_000 ||
		!token ||
		token.length > 2_048
	) {
		throw new ContactError('invalid-form', 400, 'Check the form and try again.');
	}

	return { name, email, message, token };
}

async function readJsonResponse<T>(response: Response, code: string): Promise<T> {
	if (!response.ok) {
		throw new ContactError(code, 503, 'Message delivery is temporarily unavailable.');
	}

	try {
		return (await response.json()) as T;
	} catch {
		throw new ContactError(code, 503, 'Message delivery is temporarily unavailable.');
	}
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

async function verifyTurnstile(contact: Contact, request: Request, env: Env): Promise<void> {
	const response = await env.TURNSTILE.fetch('https://turnstile.internal/siteverify', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			token: contact.token,
			remoteip: request.headers.get('CF-Connecting-IP') || undefined,
			idempotency_key: crypto.randomUUID(),
		}),
	});
	const result = await readJsonResponse<TurnstileResult>(response, 'turnstile-unavailable');
	const allowedHostnames = splitList(env.TURNSTILE_HOSTNAMES);

	if (
		result.success !== true ||
		result.action !== env.TURNSTILE_ACTION ||
		!result.hostname ||
		!allowedHostnames.has(result.hostname)
	) {
		throw new ContactError('turnstile-failed', 403, 'Verification expired. Please try again.');
	}
}

function fastmailToken(env: Env): string {
	const token = (env as Env & { FASTMAIL_API_TOKEN?: string }).FASTMAIL_API_TOKEN;
	if (!token) {
		throw new ContactError('fastmail-not-configured', 503, 'Message delivery is temporarily unavailable.');
	}
	return token;
}

function contactRecipient(env: Env): string {
	const email = (env as Env & { CONTACT_TO_EMAIL?: string }).CONTACT_TO_EMAIL?.trim().toLowerCase();
	if (!email || !isEmail(email)) {
		throw new ContactError('contact-recipient-not-configured', 503, 'Message delivery is temporarily unavailable.');
	}
	return email;
}

async function fastmailRequest<T>(url: string, token: string, body?: unknown): Promise<T> {
	const response = await fetchWithTimeout(url, {
		method: body === undefined ? 'GET' : 'POST',
		headers: {
			Accept: 'application/json',
			Authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	return readJsonResponse<T>(response, 'fastmail-request-failed');
}

function methodResult(response: JmapResponse, callId: string, expectedName: string): Record<string, unknown> {
	const item = response.methodResponses?.find((entry) => entry[2] === callId);
	if (!item || item[0] !== expectedName) {
		throw new ContactError('fastmail-method-failed', 503, 'Message delivery is temporarily unavailable.');
	}
	return item[1];
}

function chooseIdentity(identities: Identity[], preferredEmail: string): Identity {
	const preferred = identities.find((identity) => identity.email.toLowerCase() === preferredEmail);
	const exact = identities.find((identity) => identity.email.toLowerCase() === 'contact@shen.zip');
	const shenZip = identities.find((identity) => identity.email.toLowerCase().endsWith('@shen.zip'));
	const identity = preferred ?? exact ?? shenZip ?? identities[0];

	if (!identity?.id || !isEmail(identity.email)) {
		throw new ContactError('fastmail-identity-missing', 503, 'Message delivery is temporarily unavailable.');
	}
	return identity;
}

async function sendWithFastmail(contact: Contact, env: Env): Promise<void> {
	const token = fastmailToken(env);
	const recipient = contactRecipient(env);
	const session = await fastmailRequest<FastmailSession>(FASTMAIL_SESSION_URL, token);
	const mailAccount = session.primaryAccounts?.[JMAP_MAIL];
	const submissionAccount = session.primaryAccounts?.[JMAP_SUBMISSION];

	if (!session.apiUrl || !mailAccount || mailAccount !== submissionAccount) {
		throw new ContactError('fastmail-session-invalid', 503, 'Message delivery is temporarily unavailable.');
	}

	const metadata = await fastmailRequest<JmapResponse>(session.apiUrl, token, {
		using: [JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION],
		methodCalls: [
			['Identity/get', { accountId: submissionAccount }, 'identities'],
			['Mailbox/get', { accountId: mailAccount, properties: ['id', 'role'] }, 'mailboxes'],
		],
	});
	const identityData = methodResult(metadata, 'identities', 'Identity/get');
	const mailboxData = methodResult(metadata, 'mailboxes', 'Mailbox/get');
	const identity = chooseIdentity((identityData.list ?? []) as Identity[], recipient);
	const drafts = ((mailboxData.list ?? []) as Mailbox[]).find((mailbox) => mailbox.role === 'drafts');

	if (!drafts?.id) {
		throw new ContactError('fastmail-drafts-missing', 503, 'Message delivery is temporarily unavailable.');
	}

	const now = new Date().toISOString();
	const body = `New message from shen.zip\n\nName: ${contact.name}\nEmail: ${contact.email}\n\n${contact.message}`;
	const result = await fastmailRequest<JmapResponse>(session.apiUrl, token, {
		using: [JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION],
		methodCalls: [
			[
				'Email/set',
				{
					accountId: mailAccount,
					create: {
						draft: {
							mailboxIds: { [drafts.id]: true },
							keywords: { $draft: true, $seen: true },
							from: [{ name: identity.name || 'shen.zip', email: identity.email }],
							to: [{ name: 'shen.zip', email: recipient }],
							replyTo: [{ name: contact.name, email: contact.email }],
							subject: `shen.zip contact: ${contact.name}`,
							receivedAt: now,
							sentAt: now,
							bodyStructure: { type: 'text/plain', partId: 'text' },
							bodyValues: { text: { value: body, isTruncated: false } },
						},
					},
				},
				'email',
			],
			[
				'EmailSubmission/set',
				{
					accountId: submissionAccount,
					create: { submission: { identityId: identity.id, emailId: '#draft' } },
					onSuccessDestroyEmail: ['#submission'],
				},
				'submission',
			],
		],
	});
	const emailResult = methodResult(result, 'email', 'Email/set');
	const submissionResult = methodResult(result, 'submission', 'EmailSubmission/set');

	if (
		!(emailResult.created as Record<string, unknown> | undefined)?.draft ||
		!(submissionResult.created as Record<string, unknown> | undefined)?.submission
	) {
		throw new ContactError('fastmail-send-failed', 503, 'Message delivery is temporarily unavailable.');
	}
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
	const origin = request.headers.get('Origin');
	if (!isAllowedOrigin(origin, env)) {
		return json({ success: false, error: 'This form can only be sent from shen.zip.' }, 403, origin, env);
	}

	if (!request.headers.get('Content-Type')?.includes('application/json')) {
		return json({ success: false, error: 'Check the form and try again.' }, 415, origin, env);
	}

	const body = await readBody(request);
	if (body === null) {
		return json({ success: false, error: 'That message is too long.' }, 413, origin, env);
	}
	let parsedBody: unknown;
	try {
		parsedBody = JSON.parse(body);
	} catch {
		return json({ success: false, error: 'Check the form and try again.' }, 400, origin, env);
	}

	const startedAt = Date.now();
	try {
		const contact = parseContact(parsedBody);
		await verifyTurnstile(contact, request, env);
		await sendWithFastmail(contact, env);
		console.log(JSON.stringify({ event: 'contact_submit', outcome: 'ok', duration_ms: Date.now() - startedAt }));
		return json({ success: true }, 200, origin, env);
	} catch (error) {
		const contactError = error instanceof ContactError
			? error
			: new ContactError('internal-error', 503, 'Message delivery is temporarily unavailable.');
		console.error(
			JSON.stringify({
				event: 'contact_submit',
				outcome: 'error',
				code: contactError.code,
				duration_ms: Date.now() - startedAt,
			}),
		);
		return json({ success: false, error: contactError.publicMessage }, contactError.status, origin, env);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const origin = request.headers.get('Origin');

		if (request.method === 'GET' && url.pathname === '/health') {
			return json({ ok: true, service: 'shen.zip contact' }, 200, origin, env);
		}

		if (request.method === 'OPTIONS') {
			return isAllowedOrigin(origin, env)
				? new Response(null, { status: 204, headers: responseHeaders(origin, env) })
				: json({ success: false }, 403, origin, env);
		}

		if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '/contact')) {
			return handleSubmit(request, env);
		}

		return json({ success: false }, 404, origin, env);
	},
} satisfies ExportedHandler<Env>;
