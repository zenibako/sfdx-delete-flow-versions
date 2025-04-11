import fs from 'node:fs';
import { join } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Connection, Messages } from '@salesforce/core';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('sfdx-delete-flow-versions', 'flows.delete');

const folder = join(__dirname, '..', 'data');

async function mkdir(): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdir(folder, { recursive: true }, (error) => {
      if (error) {
        reject(error);
      }
      resolve();
    });
  });
}

async function writeJson(filename: string, data: object): Promise<object> {
  const filepath = join(folder, filename);

  return new Promise((resolve, reject) => {
    fs.writeFile(filepath, JSON.stringify(data, null, 2), (err) => {
      if (err) reject(err);

      resolve(data);
    });
  });
}

export type FlowsDeleteResult = {
  path: string;
};

export default class FlowsDelete extends SfCommand<FlowsDeleteResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    checkonly: Flags.boolean({
      summary: messages.getMessage('flags.checkonly.summary'),
      description: messages.getMessage('flags.checkonly.description'),
      char: 'c',
      required: false,
    }),
    /*
    'include-managed': Flags.boolean({
      summary: messages.getMessage('flags.include-managed.summary'),
      description: messages.getMessage('flags.include-managed.description'),
      char: 'm',
      required: false,
    }),
    */
    'target-org': Flags.requiredOrg(),
    'api-version': Flags.orgApiVersion(),
  };

  public async init(): Promise<void> {
    await super.init();
    return mkdir();
  }

  public async run(): Promise<FlowsDeleteResult> {
    const path = 'src/commands/flows/delete.ts';

    const { flags } = await this.parse(FlowsDelete);
    const org = flags['target-org'].getConnection(flags['api-version']);

    const flowCountsByStatus = await this.queryFlowsByNameAndStatus(org);
    const atRiskFlows = this.findAtRiskFlows(flowCountsByStatus);
    await writeJson('flows-by-status.json', flowCountsByStatus);
    await writeJson('at-risk-flows.json', atRiskFlows);

    const inactiveFlows = await this.queryInactiveFlows(org);
    this.info(`inactiveFlows count: ${inactiveFlows.length}`);
    if (inactiveFlows.length === 0) {
      this.info('✅ no inactive flows found');
      return { path };
    }
    await writeJson('inactive-flows.json', inactiveFlows);

    const flowViewIds = inactiveFlows.map((f) => f.Id.slice(0, 15));
    const interviews = await this.queryInterviewsByFlowVersion(org);
    await writeJson('flow-interviews.json', interviews);
    const interviewIds = interviews.map((i) => i.Id);
    this.info(`found ${interviews.length} FlowInterviews for ${inactiveFlows.length} FlowVersions`);

    if (flags.checkonly) {
      this.info('✅ check only complete');
      return { path };
    }

    this.info('⛔️ WARNING begin destructive changes');
    await this.deleteFlowInterviews(org, interviewIds);
    await this.deleteAllObsoleteFlows(org, flowViewIds);

    this.info('✅ all done');
    return { path };
  }

  private async queryFlowsByNameAndStatus(org: Connection, includeManaged?: boolean): Promise<AggregateResult[]> {
    const simpleQuery = `
    SELECT Definition.DeveloperName, Status, COUNT(Id)
    FROM Flow
  `;
    const excludeManagedCondition = `
    WHERE DefinitionId IN (
      SELECT Id
      FROM FlowDefinition
      WHERE NamespacePrefix = NULL
    )
  `;
    const grouping = `
    GROUP BY Definition.DeveloperName, Status
    ORDER BY Definition.DeveloperName
  `;

    const queryBlocks = [simpleQuery];
    if (!includeManaged) {
      queryBlocks.push(excludeManagedCondition);
    }
    queryBlocks.push(grouping);

    const queryLines = queryBlocks.join(' ');
    const query = queryLines
      .split('\n')
      .map((line) => line.trim())
      .join(' ');

    const results = await org.query<AggregateResult>(query);
    this.info(`flowCountsByStatus count: ${results.records.length}`);
    this.debug(results);
    return results.records;
  }

  private async queryInactiveFlows(org: Connection, includeManaged?: boolean): Promise<Flow[]> {
    const simpleQuery = `
  SELECT Definition.DeveloperName, VersionNumber, Id, Status
  FROM Flow
  WHERE Status IN ('Obsolete', 'Draft', 'InvalidDraft')
  `;
    const excludeManagedCondition = `
    AND DefinitionId IN (
      SELECT Id
      FROM FlowDefinition
      WHERE NamespacePrefix = NULL
    )
  `;
    const orderBy = 'ORDER BY Definition.DeveloperName, VersionNumber';
    const queryBlocks = [simpleQuery];
    if (!includeManaged) {
      queryBlocks.push(excludeManagedCondition);
    }
    queryBlocks.push(orderBy);

    const queryLines = queryBlocks.join(' ');
    const query = queryLines
      .split('\n')
      .map((line) => line.trim())
      .join(' ');
    // const cmd = `npx sf data query -o ${username} -q "${query}" --use-tooling-api -r json -w 10`;

    const results = await org.query<Flow>(query);
    this.debug(results);
    return results.records;
  }

  // private async queryInterviewsByFlowVersion(org: Connection, flowVersionIds: string[]): Promise<FlowInterview[]> {
  private async queryInterviewsByFlowVersion(org: Connection): Promise<FlowInterview[]> {
    // const versionIds = flowVersionIds.join('\',\'');
    const simpleQuery = `
  SELECT Id, FlowVersionViewId
  FROM FlowInterview
  LIMIT 2
  `;

    const query = simpleQuery
      .split('\n')
      .map((line) => line.trim())
      .join(' ');

    const results = await org.query<FlowInterview>(query);
    this.debug(results);
    return results.records;
  }

  private async deleteFlowInterviews(org: Connection, interviewIds: string[]): Promise<void> {
    this.info('begin deleting interviews');
    this.debug(interviewIds);
    await org.delete('FlowInterview', interviewIds);
  }

  private async deleteAllObsoleteFlows(org: Connection, flowIds: string[]): Promise<void> {
    this.info('begin deleting flow versions');
    this.debug(flowIds);
    await org.delete('Flow', flowIds);
  }

  // Find any Flows that do NOT have Active versions
  // Running the script will delete these entirely
  private findAtRiskFlows(aggResults: AggregateResult[]): string[] {
    const summary: Record<string, { active: number; inactive: number }> = {};
    for (const agg of aggResults) {
      const { DeveloperName: name, Status: status } = agg;
      if (!summary[name]) {
        summary[name] = {
          active: 0,
          inactive: 0,
        };
      }
      const item = summary[name];

      if (status === 'Active') {
        item.active++;
      } else {
        item.inactive++;
      }
    }
    const flowNames = [
      ...new Set(aggResults.filter((f) => summary[f.DeveloperName].active === 0).map((f) => f.DeveloperName)),
    ];
    this.info(`atRiskFlows count: ${flowNames.length}`);
    this.debug(flowNames);
    return flowNames;
  }
}
