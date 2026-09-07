import { describe, expect, it } from "vitest";
import {
	addActionItem,
	addTimelineEntry,
	createInitialIncident,
	transitionIncident,
} from "../src/incident";

const STARTED_AT = "2026-09-07T09:12:00.000Z";

describe("incident state", () => {
	it("creates a useful initial incident record", () => {
		const state = createInitialIncident(STARTED_AT);

		expect(state.status).toBe("investigating");
		expect(state.startedAt).toBe(STARTED_AT);
		expect(state.timeline).toHaveLength(1);
		expect(state.impactedServices).toContain("Checkout API");
	});

	it("records timeline entries immutably", () => {
		const state = createInitialIncident(STARTED_AT);
		const next = addTimelineEntry(state, {
			id: "finding-1",
			at: "2026-09-07T09:15:00.000Z",
			kind: "observation",
			message: "Payment retries increased after deploy 8f21.",
			source: "Metrics",
		});

		expect(state.timeline).toHaveLength(1);
		expect(next.timeline).toHaveLength(2);
		expect(next.timeline.at(-1)?.id).toBe("finding-1");
	});

	it("marks the incident resolved and preserves an audit entry", () => {
		const state = createInitialIncident(STARTED_AT);
		const resolvedAt = "2026-09-07T10:02:00.000Z";
		const next = transitionIncident(
			state,
			"resolved",
			"Rollback completed and checkout latency returned to baseline.",
			resolvedAt,
		);

		expect(next.status).toBe("resolved");
		expect(next.resolvedAt).toBe(resolvedAt);
		expect(next.summary).toBe("Rollback completed and checkout latency returned to baseline.");
		expect(next.timeline.at(-1)).toMatchObject({
			kind: "status",
			source: "Incident agent",
		});
	});

	it("adds owned action items to state and timeline", () => {
		const state = createInitialIncident(STARTED_AT);
		const next = addActionItem(
			state,
			"Compare payment error rates across deploys.",
			"Priya",
			"2026-09-07T09:20:00.000Z",
		);

		expect(next.actionItems.at(-1)).toMatchObject({
			owner: "Priya",
			done: false,
		});
		expect(next.timeline.at(-1)?.message).toContain("Priya assigned");
	});

	it("bounds synchronized timeline state", () => {
		let state = createInitialIncident(STARTED_AT);

		for (let index = 0; index < 50; index += 1) {
			state = addTimelineEntry(state, {
				id: `entry-${index}`,
				at: STARTED_AT,
				kind: "observation",
				message: `Finding ${index}`,
				source: "Test",
			});
		}

		expect(state.timeline).toHaveLength(40);
		expect(state.timeline[0].id).toBe("entry-10");
	});
});
