import { CliPageView } from "./cli-page-view";

/**
 * The CLI approve page's route. See cli-page-view.tsx's doc comment for why
 * the actual component lives there and this file takes nothing: Next's
 * generated route type check refuses both a page module with extra exports
 * and a default export with extra props.
 */
export default function CliPage() {
  return <CliPageView />;
}
