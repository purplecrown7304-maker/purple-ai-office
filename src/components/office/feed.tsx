import {
  agentTone,
  messageLabels,
  sortedMessages,
} from "../../lib/office/presentation";
import type { Agent, Message } from "../../lib/office/types";
import { Card, CardHeader } from "../ui/card";
export function Feed({
  messages,
  agents,
  all = false,
}: {
  messages: Message[];
  agents: Agent[];
  all?: boolean;
}) {
  const rows = sortedMessages(messages).reverse();
  const name = (id: string | null, role: string) =>
    agents.find((a) => a.id === id)?.display_name ??
    (role === "ceo" ? "대표" : "AI 팀");
  return (
    <Card className="feed-card">
      <CardHeader>
        <h2>대화</h2>
        <span className="muted">{messages.length}개 메시지</span>
      </CardHeader>
      <ol className="feed">
        {(all ? rows : rows.slice(0, 5)).map((m) => {
          const a = agents.find((a) => a.id === m.from_agent);
          return (
            <li key={m.id}>
              <span
                className={`avatar ${a ? agentTone(a) : "black"}`}
                aria-hidden="true"
              >
                {a ? a.display_name[0] : "대"}
              </span>
              <strong>
                {name(m.from_agent, m.from_role)} →{" "}
                {name(m.to_agent, m.to_role)}
              </strong>
              <p>{m.message}</p>
              <span className="muted">{messageLabels[m.type] ?? m.type}</span>
            </li>
          );
        })}
        {!rows.length && (
          <li className="empty">
            아직 대화가 없습니다. 데모 실행을 눌러 시작하세요.
          </li>
        )}
      </ol>
    </Card>
  );
}
