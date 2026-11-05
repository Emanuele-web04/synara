import type { McpConnector } from "@synara/contracts";
import { isMcpLoopbackHostname, normalizeMcpConnectorUrl } from "@synara/shared/mcpConnectors";
import { useMutation } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ensureNativeApi } from "~/nativeApi";

export function McpLocalConnectorDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUrl: (url: string) => void;
  onConnected: (connector: McpConnector) => void;
}) {
  const formId = useId();
  const [mode, setMode] = useState<"url" | "stdio">("url");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [cwd, setCwd] = useState("");
  const [env, setEnv] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      let parsedArgs: unknown;
      let parsedEnv: unknown;
      try {
        parsedArgs = JSON.parse(args);
        parsedEnv = env ? JSON.parse(env) : {};
      } catch {
        throw new Error("Arguments must be a JSON array; environment must be a JSON object.");
      }
      if (!Array.isArray(parsedArgs) || !parsedArgs.every((value) => typeof value === "string"))
        throw new Error("Arguments must be an array of strings.");
      if (
        !parsedEnv ||
        typeof parsedEnv !== "object" ||
        Array.isArray(parsedEnv) ||
        !Object.values(parsedEnv).every((value) => typeof value === "string")
      )
        throw new Error("Environment must map names to strings.");
      return ensureNativeApi().server.connectMcpConnector({
        name,
        command,
        args: parsedArgs as string[],
        env: parsedEnv as Record<string, string>,
        ...(cwd.trim() ? { cwd } : {}),
      });
    },
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (mode === "url") {
      const normalized = normalizeMcpConnectorUrl(url);
      if (!normalized.ok) {
        setError(normalized.reason);
        return;
      }
      if (!isMcpLoopbackHostname(new URL(normalized.url).hostname)) {
        setError("Use a loopback address for a local server.");
        return;
      }
      props.onUrl(normalized.url);
      return;
    }
    try {
      const result = await mutation.mutateAsync();
      if (result.connector) {
        setEnv("");
        props.onConnected(result.connector);
        props.onOpenChange(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add the local server.");
    }
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          setEnv("");
          setError(null);
        }
        props.onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add local server</DialogTitle>
          <DialogDescription>
            Connect an app on this computer by loopback URL, or approve a command to run as an MCP
            server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="space-y-3 text-ui" onSubmit={(event) => void submit(event)}>
            <label className="block">
              Transport
              <select
                aria-label="Local server transport"
                value={mode}
                className="ml-2 rounded border bg-background p-1 text-ui"
                onChange={(event) => setMode(event.target.value as "url" | "stdio")}
              >
                <option value="url">Local HTTP URL</option>
                <option value="stdio">Command (stdio)</option>
              </select>
            </label>
            {mode === "url" ? (
              <Input
                aria-label="Local MCP URL"
                placeholder="http://127.0.0.1:29979/mcp"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required
              />
            ) : (
              <>
                <label className="block">
                  Name
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={60}
                  />
                </label>
                <label className="block">
                  Command
                  <Input
                    value={command}
                    placeholder="~/.paper/bin/paper"
                    onChange={(event) => setCommand(event.target.value)}
                    required
                  />
                </label>
                <label className="block">
                  Arguments (JSON array)
                  <Input
                    value={args}
                    placeholder={'["mcp"]'}
                    onChange={(event) => setArgs(event.target.value)}
                    required
                  />
                </label>
                <label className="block">
                  Working directory
                  <Input
                    value={cwd}
                    placeholder="Home directory"
                    onChange={(event) => setCwd(event.target.value)}
                  />
                </label>
                <label className="block">
                  Environment (JSON object, values hidden)
                  <Input
                    type="password"
                    autoComplete="off"
                    value={env}
                    placeholder={'{"API_KEY":"…"}'}
                    onChange={(event) => setEnv(event.target.value)}
                  />
                </label>
                <p className="text-ui-sm text-muted-foreground">
                  Adding this server runs the exact command and arguments above. Environment values
                  are saved in Synara’s secrets store.
                </p>
              </>
            )}
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setEnv("");
              setError(null);
              props.onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={mutation.isPending}>
            {mode === "stdio" ? "Add and run server" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
