import { Dashboard } from "../components/office/dashboard";
import { requireCeo } from "../server/page-auth";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ task?: string }>;
}) {
  await requireCeo();
  const { task } = await searchParams;
  return <Dashboard key={task ?? "latest"} taskId={task} />;
}
