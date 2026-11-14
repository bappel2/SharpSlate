// The stand alone Kelly calculator (2026-10-29, sharpslate/calculators.py). The heading
// and the article are in the HTML; this draws the calculator into #app, the
// same card the Tools page shows (calc-cards.js).
import { h } from "../app.js";
import { kellyCard } from "../calc-cards.js";

const app = document.getElementById("app");
app.replaceChildren(h("div", { class: "calc-one" }, kellyCard()));
app.dataset.state = "ready";
