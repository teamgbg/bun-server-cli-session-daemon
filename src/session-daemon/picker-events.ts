/**
 * @system cli-session
 * @status handwritten
 * @edit edit directly
 *
 * Database-emission bridge for the picker. Postgres tells the daemon when a
 * registry row changes; the daemon invalidates its read caches and fans one
 * event out to connected picker views. No picker asks for state on a timer.
 */

import { createNotifyListener, getDirectDatabaseUrl } from "@teamscala/db/notify-listener/index";
import { createEventBus } from "@teamscala/event-bus/create-event-bus";
import type { NotifyListener } from "@teamscala/db/notify-listener/index";
import { invalidatePickerCaches } from "./picker-data.ts";

export interface PickerChangedEvent {
	type: "picker.changed";
	source: "database";
	slug: string;
}

export const pickerEvents = createEventBus<PickerChangedEvent>("session-picker:database-events");

let listener: NotifyListener | null = null;

/** Start exactly one process-wide LISTEN connection. Missing DB configuration
 * is a boot failure: silently falling back would leave an apparently-live
 * picker whose database-backed menu never changes. */
export async function startPickerEventBridge(): Promise<NotifyListener> {
	if (listener) return listener;
	const url = getDirectDatabaseUrl();
	if (!url) {
		throw new Error("picker event bridge requires a direct database URL");
	}
	const next = createNotifyListener(url);
	await next.listen("registry_config_changed", (slug) => {
		invalidatePickerCaches();
		pickerEvents.emit({ type: "picker.changed", source: "database", slug });
	});
	listener = next;
	return next;
}

export async function stopPickerEventBridge(): Promise<void> {
	const active = listener;
	listener = null;
	await active?.stop();
}
