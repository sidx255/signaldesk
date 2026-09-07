export type Severity = "SEV-1" | "SEV-2" | "SEV-3";
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";
export type TimelineKind = "observation" | "decision" | "action" | "status" | "reminder";

export interface TimelineEntry {
	id: string;
	at: string;
	kind: TimelineKind;
	message: string;
	source: string;
}

export interface ActionItem {
	id: string;
	text: string;
	owner: string;
	done: boolean;
}

export interface IncidentState {
	title: string;
	severity: Severity;
	status: IncidentStatus;
	commander: string;
	summary: string;
	impactedServices: string[];
	startedAt: string;
	nextUpdateAt: string | null;
	resolvedAt: string | null;
	timeline: TimelineEntry[];
	actionItems: ActionItem[];
}

const MAX_TIMELINE_ENTRIES = 40;

export function createInitialIncident(at = new Date().toISOString()): IncidentState {
	return {
		title: "Elevated checkout latency",
		severity: "SEV-2",
		status: "investigating",
		commander: "Unassigned",
		summary:
			"Customers are seeing intermittent latency during checkout. Scope and cause are under investigation.",
		impactedServices: ["Checkout API", "Payments"],
		startedAt: at,
		nextUpdateAt: null,
		resolvedAt: null,
		timeline: [
			{
				id: "incident-opened",
				at,
				kind: "status",
				message: "Incident opened and investigation started.",
				source: "SignalDesk",
			},
		],
		actionItems: [],
	};
}

export function addTimelineEntry(
	state: IncidentState,
	entry: Omit<TimelineEntry, "id"> & { id?: string },
): IncidentState {
	const nextEntry: TimelineEntry = {
		...entry,
		id: entry.id ?? crypto.randomUUID(),
	};

	return {
		...state,
		timeline: [...state.timeline, nextEntry].slice(-MAX_TIMELINE_ENTRIES),
	};
}

export function transitionIncident(
	state: IncidentState,
	status: IncidentStatus,
	note: string,
	at = new Date().toISOString(),
): IncidentState {
	return addTimelineEntry(
		{
			...state,
			status,
			summary: note,
			resolvedAt: status === "resolved" ? at : null,
		},
		{
			at,
			kind: "status",
			message: note,
			source: "Incident agent",
		},
	);
}

export function addActionItem(
	state: IncidentState,
	text: string,
	owner: string,
	at = new Date().toISOString(),
): IncidentState {
	const action: ActionItem = {
		id: crypto.randomUUID(),
		text,
		owner,
		done: false,
	};

	return addTimelineEntry(
		{ ...state, actionItems: [...state.actionItems, action] },
		{
			at,
			kind: "action",
			message: `${owner} assigned: ${text}`,
			source: "Incident agent",
		},
	);
}
