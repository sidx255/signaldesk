import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, pruneMessages, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import {
	addActionItem,
	addTimelineEntry,
	createInitialIncident,
	transitionIncident,
	type IncidentState,
} from "./incident";

const MODEL = "@cf/zai-org/glm-4.7-flash";

export class IncidentAgent extends AIChatAgent<Env, IncidentState> {
	initialState: IncidentState = createInitialIncident();
	maxPersistedMessages = 100;
	chatRecovery = true;

	@callable()
	async resetIncident() {
		const state = createInitialIncident();
		this.setState(state);
		return state;
	}

	async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
		const workersAI = createWorkersAI({ binding: this.env.AI });
		const incidentContext = JSON.stringify(this.state, null, 2);

		const result = streamText({
			model: workersAI(MODEL, { sessionAffinity: this.sessionAffinity }),
			system: `You are SignalDesk, an incident-response copilot embedded in a live war room.

Your job is to reduce operator load while preserving human control. Be concise, factual, and calm. Separate observations from hypotheses. Never invent metrics, causes, owners, or completed actions. Use tools whenever the incident record must change. Ask for missing evidence when confidence is low. A resolution always requires explicit human approval.

Current durable incident record:
${incidentContext}

${getSchedulePrompt({ date: new Date() })}

When asked for a summary, produce: current impact, evidence, working hypothesis, actions, and next update. When a user reports a new fact, record it before reasoning from it. Do not claim a tool succeeded unless its result confirms success.`,
			messages: pruneMessages({
				messages: await convertToModelMessages(this.messages),
				toolCalls: "before-last-2-messages",
				reasoning: "before-last-message",
			}),
			tools: {
				getIncidentSnapshot: tool({
					description: "Read the current durable incident record.",
					inputSchema: z.object({}),
					execute: async () => this.state,
				}),
				recordFinding: tool({
					description:
						"Record a confirmed observation, decision, or action in the incident timeline.",
					inputSchema: z.object({
						message: z.string().min(3).max(500),
						kind: z.enum(["observation", "decision", "action"]),
						source: z.string().min(2).max(80),
					}),
					execute: async ({ message, kind, source }) => {
						const nextState = addTimelineEntry(this.state, {
							at: new Date().toISOString(),
							kind,
							message,
							source,
						});
						this.setState(nextState);
						return { recorded: true, entry: nextState.timeline.at(-1) };
					},
				}),
				updateIncident: tool({
					description:
						"Update incident metadata when the user provides a title, severity, commander, summary, or impacted services.",
					inputSchema: z.object({
						title: z.string().min(3).max(120).optional(),
						severity: z.enum(["SEV-1", "SEV-2", "SEV-3"]).optional(),
						commander: z.string().min(2).max(80).optional(),
						summary: z.string().min(5).max(600).optional(),
						impactedServices: z.array(z.string().min(2).max(80)).max(12).optional(),
					}),
					execute: async (updates) => {
						const nextState = { ...this.state, ...updates };
						this.setState(nextState);
						return { updated: true, incident: nextState };
					},
				}),
				assignActionItem: tool({
					description: "Assign a concrete incident action to an owner.",
					inputSchema: z.object({
						text: z.string().min(3).max(240),
						owner: z.string().min(2).max(80),
					}),
					execute: async ({ text, owner }) => {
						const nextState = addActionItem(this.state, text, owner);
						this.setState(nextState);
						return { assigned: true, action: nextState.actionItems.at(-1) };
					},
				}),
				changeIncidentStatus: tool({
					description:
						"Move the incident to investigating, identified, monitoring, or resolved. Resolving requires human approval.",
					inputSchema: z.object({
						status: z.enum(["investigating", "identified", "monitoring", "resolved"]),
						note: z.string().min(5).max(300),
					}),
					needsApproval: async ({ status }) => status === "resolved",
					execute: async ({ status, note }) => {
						const nextState = transitionIncident(this.state, status, note);
						this.setState(nextState);
						return { changed: true, status };
					},
				}),
				scheduleNextUpdate: tool({
					description: "Schedule a durable reminder for the next stakeholder update.",
					inputSchema: z.object({
						minutesFromNow: z.number().int().min(1).max(1440),
						note: z.string().min(3).max(240),
					}),
					execute: async ({ minutesFromNow, note }) => {
						const delayInSeconds = minutesFromNow * 60;
						const nextUpdateAt = new Date(Date.now() + delayInSeconds * 1000).toISOString();
						await this.schedule(delayInSeconds, "sendUpdateReminder", note, { idempotent: true });
						this.setState({ ...this.state, nextUpdateAt });
						return { scheduled: true, nextUpdateAt };
					},
				}),
				listScheduledUpdates: tool({
					description: "List pending durable incident update reminders.",
					inputSchema: z.object({}),
					execute: async () => this.getSchedules(),
				}),
			},
			stopWhen: stepCountIs(12),
			abortSignal: options?.abortSignal,
		});

		return result.toUIMessageStreamResponse();
	}

	async sendUpdateReminder(note: string, _task: Schedule<string>) {
		const nextState = addTimelineEntry(
			{ ...this.state, nextUpdateAt: null },
			{
				at: new Date().toISOString(),
				kind: "reminder",
				message: note,
				source: "Scheduled reminder",
			},
		);
		this.setState(nextState);
		this.broadcast(
			JSON.stringify({
				type: "update-reminder",
				note,
				timestamp: new Date().toISOString(),
			}),
		);
	}
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);

		if (url.pathname === "/api/health") {
			return Response.json({
				ok: true,
				service: "signaldesk",
				model: MODEL,
			});
		}

		return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
