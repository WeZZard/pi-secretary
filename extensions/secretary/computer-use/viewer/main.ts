// The trajectory app: served by the trajectory server (server.ts) at /<agent>/,
// it reads the agent's trajectory and renders the page from it.
import { renderReview, reviewModelOf, type ReviewData } from "./page.ts";
import { bind } from "./behaviour.ts";

async function start() {
  const [, agent = ""] = location.pathname.split("/");
  try {
    const response = await fetch(`/.api/${agent}.json`);
    if (!response.ok) throw new Error(`The trajectory server answered ${response.status}.`);
    const page = renderReview(reviewModelOf(await response.json() as ReviewData));
    document.title = page.title;
    const selection = new CSSStyleSheet();
    selection.replaceSync(page.selection);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, selection];
    document.body.innerHTML = page.html;
  } catch (error) {
    const p = document.createElement("p");
    p.className = "loading";
    p.textContent = `The trajectory could not be loaded. ${error instanceof Error ? error.message : ""}`;
    document.body.replaceChildren(p);
    return;
  }
  // The fragment was resolved before its element existed; resolve it again so
  // it selects its view.
  if (location.hash) location.replace(location.hash);
  bind();
}

void start();
