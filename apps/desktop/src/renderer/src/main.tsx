import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkerPoolContextProvider } from "@pierre/diffs/react";
import { Toaster } from "sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { workerFactory } from "./pierre-worker";
import { App } from "./App";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <WorkerPoolContextProvider
        poolOptions={{ workerFactory }}
        highlighterOptions={{ theme: { dark: "pierre-dark", light: "pierre-light" } }}
      >
        <TooltipProvider delayDuration={200} skipDelayDuration={500}>
          <App />
          <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{
              style: {
                background: "var(--color-bg3)",
                color: "var(--color-fg)",
                border: "1px solid var(--color-line2)",
                fontFamily: "var(--font-sans)",
                fontSize: "12px",
              },
            }}
          />
        </TooltipProvider>
      </WorkerPoolContextProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
