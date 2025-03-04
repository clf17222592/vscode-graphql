import { GraphQLProject } from "./base";
import {
  GraphQLSchema,
  GraphQLError,
  printSchema,
  buildSchema,
  Source,
  TypeInfo,
  visit,
  visitWithTypeInfo,
  FragmentDefinitionNode,
  Kind,
  FragmentSpreadNode,
  separateOperations,
  OperationDefinitionNode,
  extendSchema,
  DocumentNode,
  FieldNode,
  ObjectTypeDefinitionNode,
  GraphQLObjectType,
  DefinitionNode,
  ExecutableDefinitionNode,
  print,
} from "graphql";
import { ValidationRule } from "graphql/validation/ValidationContext";
import { NotificationHandler, DiagnosticSeverity } from "vscode-languageserver";
import LZString from "lz-string";
import { stringifyUrl } from "query-string";

import { rangeForASTNode } from "../utilities/source";
import { formatMS } from "../format";
import { LoadingHandler } from "../loadingHandler";
import { apolloClientSchemaDocument } from "./defaultClientSchema";

import {
  FieldLatenciesMS,
  SchemaTag,
  ServiceID,
  ClientIdentity,
} from "../engine";
import { ClientConfig } from "../config";
import {
  removeDirectives,
  removeDirectiveAnnotatedFields,
  withTypenameFieldAddedWhereNeeded,
  ClientSchemaInfo,
  isDirectiveDefinitionNode,
} from "../utilities/graphql";
import { defaultValidationRules } from "../errors/validation";

import {
  collectExecutableDefinitionDiagnositics,
  DiagnosticSet,
  diagnosticsFromError,
} from "../diagnostics";
import URI from "vscode-uri";
import type { EngineDecoration } from "src/messages";
import { join } from "path";

type Maybe<T> = null | undefined | T;

function schemaHasASTNodes(schema: GraphQLSchema): boolean {
  const queryType = schema && schema.getQueryType();
  return !!(queryType && queryType.astNode);
}

function augmentSchemaWithGeneratedSDLIfNeeded(
  schema: GraphQLSchema
): GraphQLSchema {
  if (schemaHasASTNodes(schema)) return schema;

  const sdl = printSchema(schema);

  return buildSchema(
    // Rebuild the schema from a generated source file and attach the source to a `graphql-schema:/`
    // URI that can be loaded as an in-memory file by VS Code.
    new Source(sdl, `graphql-schema:/schema.graphql?${encodeURIComponent(sdl)}`)
  );
}

export function isClientProject(
  project: GraphQLProject
): project is GraphQLClientProject {
  return project instanceof GraphQLClientProject;
}

export interface GraphQLClientProjectConfig {
  clientIdentity?: ClientIdentity;
  config: ClientConfig;
  configFolderURI: URI;
  loadingHandler: LoadingHandler;
}
export class GraphQLClientProject extends GraphQLProject {
  public serviceID?: string;
  public config!: ClientConfig;

  private serviceSchema?: GraphQLSchema;

  private _onDecorations?: (any: any) => void;
  private _onSchemaTags?: NotificationHandler<[ServiceID, SchemaTag[]]>;

  private fieldLatenciesMS?: FieldLatenciesMS;
  private frontendUrlRoot?: string;

  private _validationRules?: ValidationRule[];

  public diagnosticSet?: DiagnosticSet;

  constructor({
    config,
    loadingHandler,
    configFolderURI,
    clientIdentity,
  }: GraphQLClientProjectConfig) {
    super({ config, configFolderURI, loadingHandler, clientIdentity });
    this.serviceID = config.graph;

    /**
     * This function is used in the Array.filter function below it to remove any .env files and config files.
     * If there are 0 files remaining after removing those files, we should warn the user that their config
     * may be wrong. We shouldn't throw an error here, since they could just be initially setting up a project
     * and there's no way to know for sure that there _should_ be files.
     */
    const filterConfigAndEnvFiles = (path: string) =>
      !(
        path.includes("apollo.config") ||
        path.includes(".env") ||
        (config.configURI && path === config.configURI.fsPath)
      );

    if (this.allIncludedFiles().filter(filterConfigAndEnvFiles).length === 0) {
      console.warn(
        "⚠️  It looks like there are 0 files associated with this Apollo Project. " +
          "This may be because you don't have any files yet, or your includes/excludes " +
          "fields are configured incorrectly, and Apollo can't find your files. " +
          "For help configuring Apollo projects, see this guide: https://go.apollo.dev/t/config"
      );
    }

    const { validationRules } = this.config.client;
    if (typeof validationRules === "function") {
      this._validationRules = defaultValidationRules.filter(validationRules);
    } else {
      this._validationRules = validationRules;
    }

    this.loadEngineData();
  }

  get displayName(): string {
    return this.config.graph || "Unnamed Project";
  }

  initialize() {
    return [this.scanAllIncludedFiles(), this.loadServiceSchema()];
  }

  public getProjectStats() {
    // use this to remove primitives and internal fields for stats
    const filterTypes = (type: string) =>
      !/^__|Boolean|ID|Int|String|Float/.test(type);

    // filter out primitives and internal Types for type stats to match engine
    const serviceTypes = this.serviceSchema
      ? Object.keys(this.serviceSchema.getTypeMap()).filter(filterTypes).length
      : 0;
    const totalTypes = this.schema
      ? Object.keys(this.schema.getTypeMap()).filter(filterTypes).length
      : 0;

    return {
      type: "client",
      serviceId: this.serviceID,
      types: {
        service: serviceTypes,
        client: totalTypes - serviceTypes,
        total: totalTypes,
      },
      tag: this.config.variant,
      loaded: Boolean(this.schema || this.serviceSchema),
      lastFetch: this.lastLoadDate,
    };
  }

  onDecorations(handler: (any: any) => void) {
    this._onDecorations = handler;
  }

  onSchemaTags(handler: NotificationHandler<[ServiceID, SchemaTag[]]>) {
    this._onSchemaTags = handler;
  }

  async updateSchemaTag(tag: SchemaTag) {
    await this.loadServiceSchema(tag);
    this.invalidate();
  }

  private async loadServiceSchema(tag?: SchemaTag) {
    await this.loadingHandler.handle(
      `Loading schema for ${this.displayName}`,
      (async () => {
        this.serviceSchema = augmentSchemaWithGeneratedSDLIfNeeded(
          await this.schemaProvider.resolveSchema({
            tag: tag || this.config.variant,
            force: true,
          })
        );

        this.schema = extendSchema(this.serviceSchema, this.clientSchema);
      })()
    );
  }

  async resolveSchema(): Promise<GraphQLSchema> {
    if (!this.schema) throw new Error();
    return this.schema;
  }

  get clientSchema(): DocumentNode {
    return {
      kind: Kind.DOCUMENT,
      definitions: [
        ...this.typeSystemDefinitionsAndExtensions,
        ...this.missingApolloClientDirectives,
      ],
    };
  }

  get missingApolloClientDirectives(): readonly DefinitionNode[] {
    const { serviceSchema } = this;

    const serviceDirectives = serviceSchema
      ? serviceSchema.getDirectives().map((directive) => directive.name)
      : [];

    const clientDirectives = this.typeSystemDefinitionsAndExtensions
      .filter(isDirectiveDefinitionNode)
      .map((def) => def.name.value);

    const existingDirectives = serviceDirectives.concat(clientDirectives);

    const apolloAst = apolloClientSchemaDocument.ast;
    if (!apolloAst) return [];

    const apolloDirectives = apolloAst.definitions
      .filter(isDirectiveDefinitionNode)
      .map((def) => def.name.value);

    // If there is overlap between existingDirectives and apolloDirectives,
    // don't add apolloDirectives. This is in case someone is directly including
    // the apollo directives or another framework's conflicting directives
    for (const existingDirective of existingDirectives) {
      if (apolloDirectives.includes(existingDirective)) {
        return [];
      }
    }

    return apolloAst.definitions;
  }

  private addClientMetadataToSchemaNodes() {
    const { schema, serviceSchema } = this;
    if (!schema || !serviceSchema) return;

    visit(this.clientSchema, {
      ObjectTypeExtension(node) {
        const type = schema.getType(
          node.name.value
        ) as Maybe<GraphQLObjectType>;
        const { fields } = node;
        if (!fields || !type) return;

        const localInfo: ClientSchemaInfo = type.clientSchema || {};

        localInfo.localFields = [
          ...(localInfo.localFields || []),
          ...fields.map((field) => field.name.value),
        ];

        type.clientSchema = localInfo;
      },
    });
  }

  async validate() {
    if (!this._onDiagnostics) return;
    if (!this.serviceSchema) return;

    const diagnosticSet = new DiagnosticSet();

    try {
      this.schema = extendSchema(this.serviceSchema, this.clientSchema);
      this.addClientMetadataToSchemaNodes();
    } catch (error) {
      if (error instanceof GraphQLError) {
        const uri = error.source && error.source.name;
        if (uri) {
          diagnosticSet.addDiagnostics(
            uri,
            diagnosticsFromError(error, DiagnosticSeverity.Error, "Validation")
          );
        }
      } else {
        console.error(error);
      }
      this.schema = this.serviceSchema;
    }

    const fragments = this.fragments;

    for (const [uri, documentsForFile] of this.documentsByFile) {
      for (const document of documentsForFile) {
        diagnosticSet.addDiagnostics(
          uri,
          collectExecutableDefinitionDiagnositics(
            this.schema,
            document,
            fragments,
            this._validationRules
          )
        );
      }
    }
    for (const [uri, diagnostics] of diagnosticSet.entries()) {
      this._onDiagnostics({ uri, diagnostics });
    }

    this.diagnosticSet = diagnosticSet;

    this.generateDecorations();
  }

  async loadEngineData() {
    const engineClient = this.engineClient;
    if (!engineClient) return;

    const serviceID = this.serviceID;

    await this.loadingHandler.handle(
      `Loading Apollo data for ${this.displayName}`,
      (async () => {
        try {
          if (serviceID) {
            const { schemaTags, fieldLatenciesMS } =
              await engineClient.loadSchemaTagsAndFieldLatencies(serviceID);
            this._onSchemaTags && this._onSchemaTags([serviceID, schemaTags]);
            this.fieldLatenciesMS = fieldLatenciesMS;
          }
          const frontendUrlRoot = await engineClient.loadFrontendUrlRoot();
          this.frontendUrlRoot = frontendUrlRoot;
          this.lastLoadDate = +new Date();

          this.generateDecorations();
        } catch (e) {
          console.error(e);
        }
      })()
    );
  }

  generateDecorations() {
    if (!this._onDecorations) return;
    if (!this.schema) return;

    const decorations: EngineDecoration[] = [];

    for (const [uri, queryDocumentsForFile] of this.documentsByFile) {
      for (const queryDocument of queryDocumentsForFile) {
        if (queryDocument.ast) {
          const fieldLatenciesMS = this.fieldLatenciesMS;
          const typeInfo = new TypeInfo(this.schema);
          visit(
            queryDocument.ast,
            visitWithTypeInfo(typeInfo, {
              enter: (node) => {
                if (
                  node.kind == "Field" &&
                  typeInfo.getParentType() &&
                  fieldLatenciesMS
                ) {
                  const parentName = typeInfo.getParentType()!.name;
                  const parentEngineStatMS = fieldLatenciesMS.get(parentName);
                  const engineStatMS = parentEngineStatMS
                    ? parentEngineStatMS.get(node.name.value)
                    : undefined;
                  if (engineStatMS && engineStatMS > 1) {
                    decorations.push({
                      type: "text",
                      document: uri,
                      message: `~${formatMS(engineStatMS, 0)}`,
                      range: rangeForASTNode(node),
                    });
                  }
                } else if (node.kind == "OperationDefinition") {
                  const operationWithFragments =
                    this.getOperationWithFragments(node);
                  const document = operationWithFragments
                    .map(print)
                    .join("\n\n");
                  const explorerURLState =
                    LZString.compressToEncodedURIComponent(
                      JSON.stringify({ document })
                    );

                  const frontendUrlRoot =
                    this.frontendUrlRoot ?? "https://studio.apollographql.com";

                  const variant = this.config.variant;
                  const graphId = this.config.graph;

                  const { client, service } = this.config;
                  const remoteServiceConfig =
                    typeof client.service === "object" &&
                    "url" in client.service
                      ? client.service
                      : service?.endpoint;
                  const endpoint = remoteServiceConfig?.url;

                  const runInExplorerPath = graphId
                    ? stringifyUrl({
                        url: `/graph/${graphId}/explorer`,
                        query: {
                          variant,
                          explorerURLState,
                          referrer: "vscode",
                        },
                      })
                    : stringifyUrl({
                        url: "/sandbox/explorer",
                        query: {
                          endpoint,
                          explorerURLState,
                          referrer: "vscode",
                        },
                      });
                  const runInExplorerLink = join(
                    frontendUrlRoot,
                    runInExplorerPath
                  );

                  decorations.push({
                    type: "runGlyph",
                    document: uri,
                    range: rangeForASTNode(node),
                    hoverMessage: `[Run in Studio](${runInExplorerLink})`,
                  });
                }
              },
            })
          );
        }
      }
    }

    this._onDecorations(decorations);
  }

  get fragments(): { [fragmentName: string]: FragmentDefinitionNode } {
    const fragments = Object.create(null);
    for (const document of this.documents) {
      if (!document.ast) continue;
      for (const definition of document.ast.definitions) {
        if (definition.kind === Kind.FRAGMENT_DEFINITION) {
          fragments[definition.name.value] = definition;
        }
      }
    }
    return fragments;
  }

  get operations(): { [operationName: string]: OperationDefinitionNode } {
    const operations = Object.create(null);
    for (const document of this.documents) {
      if (!document.ast) continue;
      for (const definition of document.ast.definitions) {
        if (definition.kind === Kind.OPERATION_DEFINITION) {
          if (!definition.name) {
            throw new GraphQLError(
              "Apollo does not support anonymous operations",
              [definition]
            );
          }
          operations[definition.name.value] = definition;
        }
      }
    }
    return operations;
  }

  get mergedOperationsAndFragments(): {
    [operationName: string]: DocumentNode;
  } {
    return separateOperations({
      kind: Kind.DOCUMENT,
      definitions: [
        ...Object.values(this.fragments),
        ...Object.values(this.operations),
      ],
    });
  }

  get mergedOperationsAndFragmentsForService(): {
    [operationName: string]: DocumentNode;
  } {
    const { clientOnlyDirectives, clientSchemaDirectives, addTypename } =
      this.config.client;
    const current = this.mergedOperationsAndFragments;
    if (
      (!clientOnlyDirectives || !clientOnlyDirectives.length) &&
      (!clientSchemaDirectives || !clientSchemaDirectives.length)
    )
      return current;

    const filtered = Object.create(null);
    for (const operationName in current) {
      const document = current[operationName];

      let serviceOnly = removeDirectiveAnnotatedFields(
        removeDirectives(document, clientOnlyDirectives as string[]),
        clientSchemaDirectives as string[]
      );

      if (addTypename)
        serviceOnly = withTypenameFieldAddedWhereNeeded(serviceOnly);
      // In the case we've made a document empty by filtering client directives,
      // we don't want to include that in the result we pass on.
      if (serviceOnly.definitions.filter(Boolean).length) {
        filtered[operationName] = serviceOnly;
      }
    }

    return filtered;
  }

  getOperationFieldsFromFieldDefinition(
    fieldName: string,
    parent: ObjectTypeDefinitionNode | null
  ): FieldNode[] {
    if (!this.schema || !parent) return [];
    const fields: FieldNode[] = [];
    const typeInfo = new TypeInfo(this.schema);
    for (const document of this.documents) {
      if (!document.ast) continue;
      visit(
        document.ast,
        visitWithTypeInfo(typeInfo, {
          Field(node: FieldNode) {
            if (node.name.value !== fieldName) return;
            const parentType = typeInfo.getParentType();
            if (parentType && parentType.name === parent.name.value) {
              fields.push(node);
            }
            return;
          },
        })
      );
    }
    return fields;
  }
  fragmentSpreadsForFragment(fragmentName: string): FragmentSpreadNode[] {
    const fragmentSpreads: FragmentSpreadNode[] = [];
    for (const document of this.documents) {
      if (!document.ast) continue;

      visit(document.ast, {
        FragmentSpread(node: FragmentSpreadNode) {
          if (node.name.value === fragmentName) {
            fragmentSpreads.push(node);
          }
        },
      });
    }
    return fragmentSpreads;
  }
  getOperationWithFragments(
    operationDefinition: OperationDefinitionNode
  ): ExecutableDefinitionNode[] {
    const fragments = this.fragments;
    const seenFragmentNames = new Set<string>([]);
    const allDefinitions: ExecutableDefinitionNode[] = [operationDefinition];

    const defintionsToSearch: ExecutableDefinitionNode[] = [
      operationDefinition,
    ];
    let currentDefinition: ExecutableDefinitionNode | undefined;
    while ((currentDefinition = defintionsToSearch.shift())) {
      visit(currentDefinition, {
        FragmentSpread(node: FragmentSpreadNode) {
          const fragmentName = node.name.value;
          const fragment = fragments[fragmentName];
          if (!seenFragmentNames.has(fragmentName) && fragment) {
            defintionsToSearch.push(fragment);
            allDefinitions.push(fragment);
            seenFragmentNames.add(fragmentName);
          }
        },
      });
    }

    return allDefinitions;
  }
}
