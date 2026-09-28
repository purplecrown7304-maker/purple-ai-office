import { ResourceDetail } from "../../../components/office/resource-detail";
import { requireCeo } from "../../../server/page-auth";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await requireCeo();
  return <ResourceDetail kind="agents" id={(await params).slug} />;
}
