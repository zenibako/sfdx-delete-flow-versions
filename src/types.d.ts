export type AggregateResult = {
  DeveloperName: string;
  Status: string;
  expr0: number; // count
};

export type Flow = {
  Id: string;
  Definition: {
    DeveloperName: string;
  };
  VersionNumber: string;
  Status: string;
};

export type FlowInterview = {
  Id: string;
  FlowVersionViewId: string;
};
