import { Dashboard } from "../../../components/office/dashboard";
import { requireCeo } from "../../../server/page-auth";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCeo();
  return <Dashboard taskId={(await params).id} full />;
}
