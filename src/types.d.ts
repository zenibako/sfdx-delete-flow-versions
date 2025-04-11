declare type AggregateResult = {
  DeveloperName: string;
  Status: string;
  expr0: number; // count
};

declare type Flow = {
  Id: string;
  Definition: {
    DeveloperName: string;
  };
  VersionNumber: string;
  Status: string;
};

declare type FlowInterview = {
  Id: string;
  FlowVersionViewId: string;
};
