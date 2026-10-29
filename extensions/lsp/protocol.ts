/**
 * Pure JSON-RPC `Content-Length` framing for LSP stdio transport.
 * No dependencies, no side effects — safe to unit test.
 */

export interface PendingEntry {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export const LSP_REQUEST_TIMEOUT_MS = 10_000;

export function encodeMessage(payload: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	return Buffer.concat([
		Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
		body,
	]);
}

export const LSP_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** Incremental `Content-Length` parser. Push bytes, drain complete bodies. */
export class LspFraming {
	private buffer = Buffer.alloc(0);

	push(chunk: Buffer): string[] {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		if (this.buffer.length > LSP_MAX_BUFFER_BYTES) {
			// Fail-closed cap: drop buffered bytes to avoid unbounded growth.
			this.buffer = Buffer.alloc(0);
			return [];
		}
		const messages: string[] = [];
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return messages;
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				// Skip malformed framing to avoid deadlock.
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const length = Number.parseInt(match[1]!, 10);
			const total = headerEnd + 4 + length;
			if (this.buffer.length < total) return messages;
			messages.push(this.buffer.subarray(headerEnd + 4, total).toString("utf8"));
			this.buffer = this.buffer.subarray(total);
		}
	}
}

/** Maps request id -> promise with a 10s timeout. */
export class PendingRequests {
	private readonly pending = new Map<number | string, PendingEntry>();

	get size(): number {
		return this.pending.size;
	}

	add(id: number | string): Promise<unknown> {
		this.reject(id, new Error(`Duplicate request id: ${String(id)}`));
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`LSP request ${String(id)} timed out after ${LSP_REQUEST_TIMEOUT_MS}ms`));
			}, LSP_REQUEST_TIMEOUT_MS);
			// Unref so a hanging server never keeps the process alive.
			if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
				(timer as unknown as { unref: () => void }).unref();
			}
			this.pending.set(id, { resolve, reject, timer });
		});
	}

	resolve(id: number | string, value: unknown): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		clearTimeout(entry.timer);
		this.pending.delete(id);
		entry.resolve(value);
		return true;
	}

	reject(id: number | string, err: Error): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		clearTimeout(entry.timer);
		this.pending.delete(id);
		entry.reject(err);
		return true;
	}

	rejectAll(err: Error): void {
		const entries = [...this.pending.values()];
		this.pending.clear();
		for (const entry of entries) {
			clearTimeout(entry.timer);
			entry.reject(err);
		}
	}
}
