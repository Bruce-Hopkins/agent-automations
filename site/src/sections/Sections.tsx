import type { ReactNode } from "react";
import { GitHubStar, Icon, REPO } from "../components";

const BASE = import.meta.env.BASE_URL;

const GOALS: { icon: ReactNode; title: string; body: ReactNode }[] = [
  {
    icon: Icon.dollar,
    title: "More efficient",
    body: "Costs less than an agent looping on its own. Each step uses a cheap model and finishes in a call or two.",
  },
  {
    icon: Icon.repeat,
    title: "More precise",
    body: "A saved flow runs the same steps the same way every time, so results stay consistent.",
  },
  {
    icon: Icon.sliders,
    title: "More effective",
    body: "You decide what each step sees, which model runs it and what it hands back. More control, better results.",
  },
];

export function Goals() {
  return (
    <section id="goals">
      <div className="wrap">
        <div className="section-head">
          <div className="kicker">Goals</div>
          <h2>Better than one agent doing it alone.</h2>
          <p>
            Ask Hermes for a multi-step task. With leafi, it designs a small flow of agents, checks it for free,
            shows you the diagram, and runs it once you agree. The flow is saved, so next time it's one call.
          </p>
        </div>
        <div className="goals">
          {GOALS.map((g) => (
            <article className="goal" key={g.title}>
              <div className="icon">{g.icon}</div>
              <h3>{g.title}</h3>
              <p>{g.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Prototype() {
  return (
    <section className="final">
      <div className="wrap">
        <img className="leaf-mark" src={`${BASE}leaf.svg`} alt="" width={64} height={64} />
        <h2>This is just a prototype.</h2>
        <p>More is on the way. Star the project on GitHub to follow the updates.</p>
        <div className="cta-row">
          <GitHubStar />
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer>
      <div className="wrap">
        <a className="brand" href="#top">
          <img src={`${BASE}leaf.svg`} alt="" width={24} height={24} />
          leafi
        </a>
        <span>MIT licensed · by Bruce Hopkins</span>
        <nav aria-label="Footer">
          <a href={`${REPO}#readme`}>README</a>
          <a href={`${REPO}/blob/main/agents/HOW_TO_DESIGN_YOUR_FLOW.md`}>Flow design guide</a>
          <a href={`${REPO}/blob/main/AGENTS.md`}>Agent reference</a>
          <a href={`${REPO}/blob/main/SECURITY.md`}>Security</a>
        </nav>
      </div>
    </footer>
  );
}
