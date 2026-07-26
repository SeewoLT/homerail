import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { getClient } from "../index.js";
import type { BaseResponse } from "../client.js";
import { parseSettingIdOption } from "../command-options.js";
import { orchestrationsDir, resolveTemplatePath } from "./templates.js";

export function registerRunCommand(program: Command): void {
  program
    .command("run [template]")
    .description("Start a DAG run")
    .requiredOption("--prompt <text>", "Task prompt")
    .option("--project-name <name>", "Project name")
    .option("--workflow <workflow_id>", "Run a DAG workflow synced in the Manager database")
    .option("--sync", "Sync the template to the Manager database before running it")
    .option("--profile <profile>", "Runtime profile id, or a profile YAML file to sync before running")
    .option("--setting-id <id>", "Database LLM setting id for this DAG run", parseSettingIdOption)
    .action(
      async (
        template: string | undefined,
        opts: {
          prompt: string;
          projectName?: string;
          workflow?: string;
          sync?: boolean;
          profile?: string;
          settingId?: string;
        },
      ) => {
        const globalOpts = program.opts() as {
          json?: boolean;
          baseUrl?: string;
          requestTimeout?: number;
        };
        const client = getClient(globalOpts);

        try {
          const payload: Record<string, unknown> = {
            prompt: opts.prompt,
          };
          let workflowId = opts.workflow?.trim();

          if (opts.sync) {
            if (!template) {
              console.error("Error: --sync requires a DAG template path");
              process.exitCode = 1;
              return;
            }
            const templatePath = resolveTemplatePath(orchestrationsDir(), template);
            if (!fs.existsSync(templatePath)) {
              console.error(`Error: DAG template not found: ${template}`);
              process.exitCode = 1;
              return;
            }
            const syncResp = await client.post<BaseResponse>("/api/dag/workflows/sync", {
              yaml_text: fs.readFileSync(templatePath, "utf8"),
              source_path: templatePath,
            });
            const syncData = syncResp.data as { workflow?: { workflow_id?: string } } | undefined;
            workflowId = syncData?.workflow?.workflow_id;
            if (!workflowId) throw new Error("Manager did not return workflow_id after DAG sync");
            payload.workflow_id = workflowId;
          } else if (workflowId) {
            payload.workflow_id = workflowId;
          } else if (template) {
            payload.yamlPath = template;
          } else {
            console.error("Error: provide a DAG template path or --workflow <workflow_id>");
            process.exitCode = 1;
            return;
          }
          if (opts.projectName) {
            payload.projectName = opts.projectName;
          }
          if (opts.profile) {
            const maybeProfilePath = path.resolve(opts.profile);
            if (fs.existsSync(maybeProfilePath)) {
              if (!workflowId) {
                console.error("Error: profile YAML sync requires --workflow or template --sync");
                process.exitCode = 1;
                return;
              }
              const profileResp = await client.post<BaseResponse>("/api/dag/profiles/sync", {
                yaml_text: fs.readFileSync(maybeProfilePath, "utf8"),
                workflow_id: workflowId,
                source_path: maybeProfilePath,
              });
              const profileData = profileResp.data as { profile?: { profile_id?: string } } | undefined;
              const profileId = profileData?.profile?.profile_id;
              if (!profileId) throw new Error("Manager did not return profile_id after profile sync");
              payload.profile = profileId;
            } else {
              payload.profile = opts.profile;
            }
          }
          if (opts.settingId) {
            payload.llm_setting_id = opts.settingId;
          }
          const resp = await client.post<BaseResponse>(
            "/api/runs/create-and-run",
            payload,
          );

          if (globalOpts.json) {
            console.log(JSON.stringify(resp));
            return;
          }

          const data = resp.data as Record<string, unknown> | undefined;
          const runId = data?.run_id ?? data?.runId ?? "?";
          console.log(`Run started: ${runId}`);
          if (payload.workflow_id) console.log(`Workflow: ${payload.workflow_id}`);
          if (payload.profile) console.log(`Profile: ${payload.profile}`);
          if (resp.message) console.log(`  ${resp.message}`);
        } catch (err: unknown) {
          console.error(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exitCode = 1;
        }
      },
    );
}
