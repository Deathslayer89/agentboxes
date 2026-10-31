import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import type Docker from "dockerode";
import { templateImage, type Template } from "../models/template.js";

const LABEL = "agentbox.template";

// Where templates live: Docker images carrying the agentbox.template label.
export interface TemplateRepository {
  list(): Promise<Template[]>;
}

export class DockerTemplateRepository implements TemplateRepository {
  constructor(private readonly docker: Docker) {}

  async list(): Promise<Template[]> {
    const images = await this.docker.listImages({ filters: { label: [LABEL] } });
    return images
      .map((image) => image.Labels?.[LABEL] ?? "")
      .filter((name) => name !== "")
      .sort()
      .map((name) => ({ name, image: templateImage(name) }));
  }

  /**
   * Builds the Dockerfile's directory as the build context, tags the image agentbox/<name>
   * and labels it so list() finds it. Each line of build output goes to onLog.
   */
  async build(name: string, dockerfilePath: string, onLog: (line: string) => void): Promise<Template> {
    const context = dirname(dockerfilePath);
    const stream = await this.docker.buildImage(
      { context, src: readdirSync(context) },
      { t: templateImage(name), dockerfile: basename(dockerfilePath), labels: { [LABEL]: name } },
    );
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event: { stream?: string; error?: string }) => {
          if (event.stream) onLog(event.stream.replace(/\n$/, ""));
          if (event.error) reject(new Error(event.error));
        },
      );
    });
    return { name, image: templateImage(name) };
  }
}

export class InMemoryTemplateRepository implements TemplateRepository {
  constructor(readonly templates: Template[] = []) {}

  async list(): Promise<Template[]> {
    return this.templates;
  }
}
