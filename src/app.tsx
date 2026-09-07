import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import {
	Activity,
	ArrowUp,
	Bot,
	Check,
	ChevronRight,
	CircleAlert,
	Clock3,
	History,
	ListChecks,
	Radio,
	RotateCcw,
	ShieldCheck,
	Square,
	UserRound,
	X,
} from "lucide-react";
import type { IncidentAgent } from "./server";
import { createInitialIncident, type IncidentState } from "./incident";

const DEMO_ROOM = "checkout-war-room";
const EMPTY_STATE = createInitialIncident("2026-09-07T09:12:00.000Z");

function formatTime(value: string | null) {
	if (!value) return "Not scheduled";
	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(value));
}

function titleCase(value: string) {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function ToolEvent({
	part,
	approve,
}: {
	part: UIMessage["parts"][number];
	approve: (response: { id: string; approved: boolean }) => void;
}) {
	if (!isToolUIPart(part)) return null;
	const name = getToolName(part)
		.replace(/([A-Z])/g, " $1")
		.trim();
	const approval = "approval" in part ? part.approval : undefined;
	const approvalId = approval && "id" in approval ? approval.id : undefined;

	if (part.state === "approval-requested") {
		return (
			<div className="tool-event tool-event--approval">
				<div className="tool-event__heading">
					<ShieldCheck size={15} />
					<strong>Approval required</strong>
				</div>
				<p>{name}</p>
				<pre>{JSON.stringify(part.input, null, 2)}</pre>
				<div className="tool-event__actions">
					<button
						className="button button--danger"
						onClick={() => approvalId && approve({ id: approvalId, approved: true })}
					>
						<Check size={15} /> Approve
					</button>
					<button
						className="button button--quiet"
						onClick={() => approvalId && approve({ id: approvalId, approved: false })}
					>
						<X size={15} /> Reject
					</button>
				</div>
			</div>
		);
	}

	const complete = part.state === "output-available";
	const failed = part.state === "output-error" || part.state === "output-denied";
	const failureMessage = part.state === "output-error" ? part.errorText : "Execution was denied.";

	return (
		<div className={`tool-event ${failed ? "tool-event--failed" : ""}`}>
			<div className="tool-event__heading">
				{complete ? <Check size={15} /> : failed ? <X size={15} /> : <Activity size={15} />}
				<strong>{titleCase(name)}</strong>
				<span>{complete ? "Complete" : failed ? "Stopped" : "Running"}</span>
			</div>
			{failed && (
				<>
					<pre>{JSON.stringify(part.input, null, 2)}</pre>
					<p>{failureMessage}</p>
				</>
			)}
		</div>
	);
}

function IncidentOverview({ state }: { state: IncidentState }) {
	return (
		<aside className="overview" aria-label="Incident overview">
			<div className="section-kicker">Active incident</div>
			<div className="severity-line">
				<span className={`severity severity--${state.severity.toLowerCase()}`}>
					{state.severity}
				</span>
				<span className="status-label">
					<span className="pulse" /> {titleCase(state.status)}
				</span>
			</div>
			<h1>{state.title}</h1>
			<p className="incident-summary">{state.summary}</p>

			<dl className="facts">
				<div>
					<dt>Commander</dt>
					<dd>
						<UserRound size={14} /> {state.commander}
					</dd>
				</div>
				<div>
					<dt>Started</dt>
					<dd>
						<Clock3 size={14} /> {formatTime(state.startedAt)}
					</dd>
				</div>
				<div>
					<dt>Next update</dt>
					<dd>
						<Radio size={14} /> {formatTime(state.nextUpdateAt)}
					</dd>
				</div>
			</dl>

			<div className="overview-block">
				<h2>Impacted services</h2>
				<div className="service-list">
					{state.impactedServices.map((service) => (
						<span key={service}>{service}</span>
					))}
				</div>
			</div>

			<div className="overview-block">
				<h2>
					<ListChecks size={15} /> Open actions
				</h2>
				{state.actionItems.length === 0 ? (
					<p className="muted">No actions assigned yet.</p>
				) : (
					<ul className="action-list">
						{state.actionItems.map((action) => (
							<li key={action.id}>
								<span className="checkbox" />
								<div>
									{action.text}
									<small>{action.owner}</small>
								</div>
							</li>
						))}
					</ul>
				)}
			</div>
		</aside>
	);
}

function Timeline({ state }: { state: IncidentState }) {
	return (
		<aside className="timeline-panel" aria-label="Incident timeline">
			<div className="panel-heading">
				<div>
					<div className="section-kicker">Shared memory</div>
					<h2>Timeline</h2>
				</div>
				<History size={18} />
			</div>
			<div className="timeline">
				{[...state.timeline].reverse().map((entry) => (
					<article className="timeline-entry" key={entry.id}>
						<div className={`timeline-dot timeline-dot--${entry.kind}`} />
						<time>{formatTime(entry.at)}</time>
						<p>{entry.message}</p>
						<small>{entry.source}</small>
					</article>
				))}
			</div>
		</aside>
	);
}

export default function App() {
	const [connected, setConnected] = useState(false);
	const [input, setInput] = useState("");
	const [notice, setNotice] = useState<string | null>(null);
	const endRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const agent = useAgent<IncidentAgent>({
		agent: "incident-agent",
		name: DEMO_ROOM,
		onOpen: useCallback(() => setConnected(true), []),
		onClose: useCallback(() => setConnected(false), []),
		onMessage: useCallback((event: MessageEvent) => {
			try {
				const data = JSON.parse(String(event.data));
				if (data.type === "update-reminder") setNotice(data.note);
			} catch {
				// Protocol messages are not all JSON application events.
			}
		}, []),
	});

	const {
		messages,
		sendMessage,
		clearHistory,
		addToolApprovalResponse,
		stop,
		status: chatStatus,
	} = useAgentChat({ agent, experimental_throttle: 80 });

	const incident = (agent.state as IncidentState | undefined) ?? EMPTY_STATE;
	const isStreaming = chatStatus === "streaming" || chatStatus === "submitted";

	useEffect(() => {
		endRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	useEffect(() => {
		if (!isStreaming) inputRef.current?.focus();
	}, [isStreaming]);

	function send(text = input) {
		const message = text.trim();
		if (!message || isStreaming || !connected) return;
		setInput("");
		sendMessage({ role: "user", parts: [{ type: "text", text: message }] });
	}

	async function resetWorkspace() {
		clearHistory();
		await agent.stub.resetIncident();
		setNotice(null);
	}

	return (
		<div className="app-shell">
			<header className="topbar">
				<a className="brand" href="/" aria-label="SignalDesk home">
					<span className="brand-mark">
						<Activity size={19} />
					</span>
					<span>SignalDesk</span>
				</a>
				<div className="room-label">
					<span className={connected ? "connection-dot is-online" : "connection-dot"} />
					{connected ? "War room connected" : "Reconnecting"}
				</div>
				<button
					className="icon-button"
					onClick={resetWorkspace}
					title="Reset demo"
					aria-label="Reset demo"
				>
					<RotateCcw size={17} />
				</button>
			</header>

			{notice && (
				<div className="notice" role="status">
					<CircleAlert size={17} />
					<span>
						<strong>Update due:</strong> {notice}
					</span>
					<button onClick={() => setNotice(null)} aria-label="Dismiss reminder">
						<X size={16} />
					</button>
				</div>
			)}

			<main className="workspace">
				<IncidentOverview state={incident} />

				<section className="chat" aria-label="Incident copilot chat">
					<div className="chat-heading">
						<div>
							<div className="section-kicker">Cloudflare AI</div>
							<h2>Response copilot</h2>
						</div>
						<div className="model-badge">
							<Bot size={14} /> GLM 4.7
						</div>
					</div>

					<div className="messages" aria-live="polite">
						{messages.length === 0 && (
							<div className="empty-chat">
								<span>
									<Bot size={24} />
								</span>
								<h3>What changed?</h3>
								<p>Report evidence, assign an action, or ask for a stakeholder-ready update.</p>
								<div className="prompt-grid">
									{[
										"Summarize the incident for leadership",
										"Record: payment retries rose after the 09:05 deploy",
										"Assign Priya to compare the last two deploys",
										"Schedule the next update in 15 minutes",
									].map((prompt) => (
										<button key={prompt} onClick={() => send(prompt)} disabled={!connected}>
											<span>{prompt}</span>
											<ChevronRight size={15} />
										</button>
									))}
								</div>
							</div>
						)}

						{messages.map((message) => (
							<div className={`message-group message-group--${message.role}`} key={message.id}>
								<div className="message-author">
									{message.role === "user" ? <UserRound size={14} /> : <Bot size={14} />}
									{message.role === "user" ? "Operator" : "SignalDesk"}
								</div>
								{message.parts.map((part, index) => {
									const key = `${message.id}-${index}`;
									if (isToolUIPart(part)) {
										return <ToolEvent key={key} part={part} approve={addToolApprovalResponse} />;
									}
									if (part.type === "text" && part.text) {
										return (
											<div className="message-bubble" key={key}>
												{part.text}
											</div>
										);
									}
									if (part.type === "reasoning" && part.text) {
										return (
											<details className="reasoning" key={key}>
												<summary>Reasoning trace</summary>
												<p>{part.text}</p>
											</details>
										);
									}
									return null;
								})}
							</div>
						))}
						<div ref={endRef} />
					</div>

					<form
						className="composer"
						onSubmit={(event) => {
							event.preventDefault();
							send();
						}}
					>
						<textarea
							ref={inputRef}
							value={input}
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									send();
								}
							}}
							placeholder={
								connected
									? "Share an observation or ask for the next move..."
									: "Connecting to incident room..."
							}
							rows={1}
							disabled={!connected}
							aria-label="Message SignalDesk"
						/>
						{isStreaming ? (
							<button
								type="button"
								className="send-button"
								onClick={stop}
								aria-label="Stop response"
							>
								<Square size={16} />
							</button>
						) : (
							<button
								type="submit"
								className="send-button"
								disabled={!input.trim() || !connected}
								aria-label="Send message"
							>
								<ArrowUp size={18} />
							</button>
						)}
						<div className="composer-meta">
							<span>Enter to send</span>
							<span>Durable memory on</span>
						</div>
					</form>
				</section>

				<Timeline state={incident} />
			</main>
		</div>
	);
}
