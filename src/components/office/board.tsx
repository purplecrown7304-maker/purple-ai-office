import Link from "next/link";
import { boardColumns, statusLabels } from "../../lib/office/presentation";
import type { Task } from "../../lib/office/types";
import { Card, CardHeader } from "../ui/card";
export function Board({
  tasks,
  selected,
}: {
  tasks: Task[];
  selected?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <h2>작업 보드</h2>
      </CardHeader>
      <div className="board">
        {boardColumns.map((col) => {
          const rows = tasks.filter((t) => col.statuses.includes(t.status));
          return (
            <section
              key={col.label}
              className={`board-column ${rows.some((t) => t.id === selected) ? "selected-column" : ""}`}
              aria-label={col.label}
            >
              <h3>
                {col.label}
                <span>{rows.length}</span>
              </h3>
              <div className="board-items">
                {rows.map((t) => (
                  <Link
                    href={`/?task=${t.id}`}
                    key={t.id}
                    className={`task-tile ${t.id === selected ? "selected-task" : ""}`}
                    aria-current={t.id === selected ? "true" : undefined}
                  >
                    <b>{t.code}</b>
                    <span>{t.title}</span>
                    <small>{statusLabels[t.status]}</small>
                    <span className="duo" aria-hidden="true">
                      <i />
                      <i />
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <p className="muted board-note">
        작업을 선택하면 담당과 대화를 확인할 수 있어요.
      </p>
    </Card>
  );
}
