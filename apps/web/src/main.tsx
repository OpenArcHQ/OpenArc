import "./csp-bootstrap.js";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { getWebBuildInfo } from "./build.js";
import "./styles.css";

const build = getWebBuildInfo(import.meta.env.VITE_COMMIT_SHA);
document
  .querySelector('meta[name="openarc-build-sha"]')
  ?.setAttribute("content", build.commitSha);

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("OpenArc root element is missing");

createRoot(root).render(
  <StrictMode>
    <App build={build} />
  </StrictMode>,
);
