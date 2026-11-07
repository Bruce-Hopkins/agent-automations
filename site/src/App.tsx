import { useEffect, useState } from "react";
import { Icon, REPO } from "./components";
import { Hero } from "./hero/Hero";
import { Footer, Goals, Prototype } from "./sections/Sections";

const BASE = import.meta.env.BASE_URL;

export function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Goals />
        <Prototype />
      </main>
      <Footer />
    </>
  );
}

/** Light-on-dark while it sits over the hero; the page's own theme after that. */
function Nav() {
  const [onHero, setOnHero] = useState(true);
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      const hero = document.getElementById("top");
      setOnHero(hero ? hero.getBoundingClientRect().bottom > 64 : false);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <header className={`nav${onHero ? " on-hero" : ""}`}>
      <div className="wrap">
        <a className="brand" href="#top">
          <img src={`${BASE}leaf.svg`} alt="" width={28} height={28} />
          leafi
        </a>
        <nav className="nav-links" aria-label="Main">
          <a className="hide-sm" href="#goals">Goals</a>
          <a className="btn btn-sm" href={REPO}>
            {Icon.github}
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}
