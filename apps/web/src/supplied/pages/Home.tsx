import { useReveal } from "../hooks/useReveal";
import Nav from "../sections/Nav";
import Hero from "../sections/Hero";
import StackOrbit from "../sections/StackOrbit";
import RequestSeparator from "../sections/LogoMarquee";
import Difference from "../sections/Difference";
import Features from "../sections/Features";
import UseCases from "../sections/UseCases";
import HowItWorks from "../sections/HowItWorks";
import Results from "../sections/Results";
import Examples from "../sections/Examples";
import Integrations from "../sections/Integrations";
import CaseStudy from "../sections/CaseStudy";
import Roadmap from "../sections/Roadmap";
import About from "../sections/About";
import Faq from "../sections/Faq";
import Cta from "../sections/Cta";
import Footer from "../sections/Footer";

export default function Home() {
  const ref = useReveal<HTMLDivElement>();

  return (
    <div ref={ref} className="supplied-home min-h-screen bg-bg font-sans text-ink antialiased">
      <Nav />
      <main id="supplied-main-content" tabIndex={-1}>
        <Hero />
        <StackOrbit />
        <About />
        <RequestSeparator />
        <Difference />
        <Features />
        <UseCases />
        <HowItWorks />
        <Results />
        <Examples />
        <Integrations />
        <CaseStudy />
        <Roadmap />
        <Faq />
        <Cta />
      </main>
      <Footer />
    </div>
  );
}
