import { SetupForm } from "../../components/office/forms";
import { requireCeo } from "../../server/page-auth";
export const dynamic = "force-dynamic";
export default async function Page() {
  await requireCeo();
  return <SetupForm />;
}
