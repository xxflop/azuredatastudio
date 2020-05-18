/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as azdata from 'azdata';
import * as vscode from 'vscode';
import * as mssql from '../../../mssql';
import * as nls from 'vscode-nls';
import { TelemetryReporter, SqlAssessmentTelemetryView, SqlTelemetryActions } from '../telemetry';

const localize = nls.loadMessageBundle();
const tabName = 'sql-assessment-tab';

export enum AssessmentType {
	AvailableRules = 1,
	InvokeAssessment = 2
}

/**
 * The main controller class that initializes the extension
 */
export default class MainController {
	private extensionContext: vscode.ExtensionContext;
	private sqlAssessment!: mssql.ISqlAssessmentService;
	private connectionUri: string = '';
	private assessmentPropertiesContainer!: azdata.PropertiesContainerComponent;
	private apiVersionPropItem: azdata.PropertiesContainerItem;
	private defaultRulesetPropItem: azdata.PropertiesContainerItem;
	private toDispose: vscode.Disposable[] = [];
	private lastInvokedResults!: mssql.SqlAssessmentResultItem[];
	private tblResults!: azdata.DeclarativeTableComponent;
	private btnExportAsScript!: azdata.ButtonComponent;
	private isServerConnection: boolean = false;
	private connectionProfile!: azdata.connection.ConnectionProfile;
	private invokeAssessmentLabel: string = localize('invokeAssessmentLabelServer', "Invoke assessment");
	private getItemsLabel: string = localize('getAssessmentItemsServer', "View applicable rules");
	private modelView!: azdata.ModelView;

	public constructor(context: vscode.ExtensionContext) {
		this.apiVersionPropItem = { displayName: localize('propApiVersion', "API Version"), value: '' };
		this.defaultRulesetPropItem = { displayName: localize('propDefaultRuleset', "Default Ruleset"), value: '' };
		this.extensionContext = context;
	}
	/**
	 */
	public deactivate(): void {
		this.toDispose.forEach(disposable => disposable.dispose());
	}

	public async activate(): Promise<boolean> {
		this.sqlAssessment = ((await vscode.extensions.getExtension(mssql.extension.name)?.activate() as mssql.IExtension)).sqlAssessment;
		this.registerModelView();
		TelemetryReporter.sendViewEvent(SqlAssessmentTelemetryView);
		return true;
	}

	private registerModelView(): void {
		azdata.ui.registerModelViewProvider(tabName, async (view) => {
			this.connectionUri = await azdata.connection.getUriForConnection(view.connection.connectionId);
			this.connectionProfile = await azdata.connection.getCurrentConnection();
			this.isServerConnection = !this.connectionProfile.databaseName || this.connectionProfile.databaseName === 'master';
			if (!this.isServerConnection) {
				this.invokeAssessmentLabel = localize('invokeAssessmentLabelDatabase', "Invoke assessment for {0}", this.connectionProfile.databaseName);
				this.getItemsLabel = localize('getAssessmentItemsDatabase', "View applicable rules for {0}", this.connectionProfile.databaseName);
			}
			const rootContainer = view.modelBuilder.flexContainer().withLayout(
				{
					flexFlow: 'column',
					width: '100%',
					height: '100%'
				}).component();

			rootContainer.addItem(await this.createPropertiesSection(view), { flex: '0 0 auto' });
			rootContainer.addItem(await this.createToolbar(view), {
				flex: '0 0 auto', CSSStyles: {
					'border-top': '3px solid rgb(221, 221, 221)',
					'margin-top': '20px',
					'height': '32px'
				}
			});
			this.tblResults = await this.createTable(view);
			this.modelView = view;
			rootContainer.addItem(this.tblResults, { flex: '1 1 auto' });
			rootContainer.addItem(view.modelBuilder.dom().withProperties<azdata.DomProperties>({
				html: '<style> .cls1 {padding-right: 10px}</style>'
			}).component());
			await view.initializeModel(rootContainer);

		});
	}

	private async createPropertiesSection(view: azdata.ModelView): Promise<azdata.FlexContainer> {
		const serverInfo = await azdata.connection.getServerInfo(view.connection.connectionId);
		const propertiesContainer = view.modelBuilder.flexContainer()
			.withLayout({
				flexFlow: 'row',
				justifyContent: 'flex-start'
			}).component();

		const apiInformationContainer = view.modelBuilder.flexContainer()
			.withLayout({
				flexFlow: 'column',
				alignContent: 'flex-start'
			}).component();
		apiInformationContainer.addItem(
			view.modelBuilder.text().withProperties({ value: 'API Information' }).component(), {
			CSSStyles: { 'font-size': 'larger' }
		});

		this.assessmentPropertiesContainer = view.modelBuilder.propertiesContainer()
			.withProperties<azdata.PropertiesContainerComponentProperties>({
				propertyItems: [
					this.apiVersionPropItem,
					this.defaultRulesetPropItem]
			}).component();

		apiInformationContainer.addItem(this.assessmentPropertiesContainer, {
			CSSStyles: {
				'margin-left': '20px'
			}
		});

		const sqlServerContainer = view.modelBuilder.flexContainer()
			.withLayout({
				flexFlow: 'column',
				alignContent: 'flex-start'
			}).component();
		sqlServerContainer.addItem(
			view.modelBuilder.text().withProperties({ value: 'SQL Server Instance Details' }).component(), {
			CSSStyles: { 'font-size': 'larger' }
		});
		sqlServerContainer.addItem(
			view.modelBuilder.propertiesContainer()
				.withProperties<azdata.PropertiesContainerComponentProperties>({
					propertyItems: [
						{ displayName: 'Version', value: serverInfo.serverVersion },
						{ displayName: 'Instance Name', value: this.connectionProfile.serverName },
						{ displayName: 'Edititon', value: serverInfo.serverEdition },
						{ displayName: 'OS Version', value: serverInfo.osVersion },
					]
				}).component(), {
			CSSStyles: {
				'margin-left': '20px'
			}
		});

		propertiesContainer.addItem(apiInformationContainer, { flex: '0 0 300px', CSSStyles: { 'margin-left': '10px' } });
		propertiesContainer.addItem(sqlServerContainer, { flex: '1 1 auto' });

		return propertiesContainer;
	}

	private async performServerAssessment(asmtType: AssessmentType): Promise<void> {
		let databaseListRequest = azdata.connection.listDatabases(this.connectionProfile.connectionId);
		let assessmentResult = asmtType === AssessmentType.InvokeAssessment
			? await this.sqlAssessment.assessmentInvoke(this.connectionUri, mssql.SqlAssessmentTargetType.Server)
			: await this.sqlAssessment.getAssessmentItems(this.connectionUri, mssql.SqlAssessmentTargetType.Server);
		this.displayResults(assessmentResult, asmtType);

		let connectionProvider = azdata.dataprotocol.getProvider<azdata.ConnectionProvider>(
			this.connectionProfile.providerId, azdata.DataProviderType.ConnectionProvider);

		const dbList = await databaseListRequest;

		for (let nDbName = 0; nDbName < dbList.length; nDbName++) {
			const db = dbList[nDbName];

			if (await connectionProvider.changeDatabase(this.connectionUri, db)) {
				let assessmentResult = asmtType === AssessmentType.InvokeAssessment
					? await this.sqlAssessment.assessmentInvoke(this.connectionUri, mssql.SqlAssessmentTargetType.Database)
					: await this.sqlAssessment.getAssessmentItems(this.connectionUri, mssql.SqlAssessmentTargetType.Database);

				this.appendResults(assessmentResult.items, asmtType);
			}
		}
	}

	private async createToolbar(view: azdata.ModelView): Promise<azdata.ToolbarContainer> {
		const targetIconPath = this.isServerConnection
			? {
				dark: this.extensionContext.asAbsolutePath('resources/dark/server.svg'),
				light: this.extensionContext.asAbsolutePath('resources/light/server.svg')
			} : {
				dark: this.extensionContext.asAbsolutePath('resources/dark/database.svg'),
				light: this.extensionContext.asAbsolutePath('resources/light/database.svg')
			};

		const btnInvokeAssessment = view.modelBuilder.button()
			.withProperties<azdata.ButtonProperties>({
				label: this.invokeAssessmentLabel,
				iconPath: targetIconPath,
			}).component();
		const btnInvokeAssessmentLoading = view.modelBuilder.loadingComponent()
			.withItem(btnInvokeAssessment)
			.withProperties<azdata.LoadingComponentProperties>({
				loadingText: this.invokeAssessmentLabel,
				showText: true,
				loading: false
			}).component();
		this.toDispose.push(btnInvokeAssessment.onDidClick(async () => {
			btnInvokeAssessmentLoading.loading = true;
			if (this.isServerConnection) {
				TelemetryReporter.sendActionEvent(SqlAssessmentTelemetryView, SqlTelemetryActions.InvokeServerAssessment);
				await this.performServerAssessment(AssessmentType.InvokeAssessment);
			} else {
				TelemetryReporter.sendActionEvent(SqlAssessmentTelemetryView, SqlTelemetryActions.InvokeDatabaseAssessment);
				let assessmentResult = await this.sqlAssessment.assessmentInvoke(this.connectionUri, mssql.SqlAssessmentTargetType.Database);
				this.displayResults(assessmentResult, AssessmentType.InvokeAssessment);
			}
			btnInvokeAssessmentLoading.loading = false;
		}));

		const btnGetAssessmentItems = view.modelBuilder.button()
			.withProperties<azdata.ButtonProperties>({
				label: this.getItemsLabel,
				iconPath: targetIconPath,
			}).component();
		const btnGetAssessmentItemsLoading = view.modelBuilder.loadingComponent()
			.withItem(btnGetAssessmentItems)
			.withProperties<azdata.LoadingComponentProperties>({
				loadingText: this.getItemsLabel,
				showText: true,
				loading: false
			}).component();
		this.toDispose.push(btnGetAssessmentItems.onDidClick(async () => {
			btnGetAssessmentItemsLoading.loading = true;
			if (this.isServerConnection) {
				TelemetryReporter.sendActionEvent(SqlAssessmentTelemetryView, SqlTelemetryActions.GetServerAssessmentRules);
				await this.performServerAssessment(AssessmentType.AvailableRules);
			} else {
				TelemetryReporter.sendActionEvent(SqlAssessmentTelemetryView, SqlTelemetryActions.GetDatabaseAssessmentRules);
				let assessmentResult = await this.sqlAssessment.assessmentInvoke(this.connectionUri, mssql.SqlAssessmentTargetType.Database);
				this.displayResults(assessmentResult, AssessmentType.AvailableRules);
			}
			btnGetAssessmentItemsLoading.loading = false;
		}));

		this.btnExportAsScript = view.modelBuilder.button()
			.withProperties<azdata.ButtonProperties>({
				label: localize('btnExportAsScript', "Export as script"),
				iconPath: {
					dark: this.extensionContext.asAbsolutePath('resources/dark/newquery_inverse.svg'),
					light: this.extensionContext.asAbsolutePath('resources/light/newquery.svg')
				},
				enabled: false
			}).component();
		this.toDispose.push(this.btnExportAsScript.onDidClick(async () => {
			TelemetryReporter.sendActionEvent(SqlAssessmentTelemetryView, SqlTelemetryActions.ExportAssessmentResults);
			this.sqlAssessment.generateAssessmentScript(this.lastInvokedResults, '', '', azdata.TaskExecutionMode.script);
		}));

		let btnViewSamples = view.modelBuilder.button()
			.withProperties<azdata.ButtonProperties>({
				label: localize('btnViewSamples', "View all rules and learn more on GitHub"),
				iconPath: {
					dark: this.extensionContext.asAbsolutePath('resources/dark/configuredashboard_inverse.svg'),
					light: this.extensionContext.asAbsolutePath('resources/light/configuredashboard.svg')
				},
			}).component();

		this.toDispose.push(btnViewSamples.onDidClick(() => {
			TelemetryReporter.sendActionEvent(SqlAssessmentTelemetryView, SqlTelemetryActions.LearnMoreAssessmentLink);
			vscode.env.openExternal(vscode.Uri.parse('https://aka.ms/sql-assessment-api'));
		}));

		return view.modelBuilder.toolbarContainer()
			.withToolbarItems(
				[
					{ component: btnInvokeAssessmentLoading },
					{ component: btnGetAssessmentItemsLoading },
					{ component: this.btnExportAsScript },
					{ component: btnViewSamples }
				]
			).component();
	}

	private async createTable(view: azdata.ModelView): Promise<azdata.DeclarativeTableComponent> {
		const tableHeader = {
			'border': 'none',
			'border-right': '1px dotted silver',
			'border-bottom': '2px solid #bbb',
		};
		const rowStyle = {
			'border': 'none',
			'border-right': '1px dotted silver'
		};



		let table = view.modelBuilder.declarativeTable()
			.withProperties<azdata.DeclarativeTableProperties>({
				columns: [
					{
						displayName: 'Target',
						headerCssStyles: tableHeader,
						valueType: azdata.DeclarativeDataType.string,
						width: /*'8%'*/100,
						rowCssStyles: rowStyle,
						isReadOnly: true
					},
					{
						displayName: 'Severity',
						headerCssStyles: tableHeader,
						valueType: azdata.DeclarativeDataType.string,
						width: /*'7%'*/80,
						rowCssStyles: rowStyle,
						isReadOnly: true
					},
					{
						displayName: 'Message',
						headerCssStyles: tableHeader,
						valueType: azdata.DeclarativeDataType.component,
						width: 900,
						rowCssStyles: rowStyle,
						isReadOnly: true
					},
					{
						displayName: 'Tags',
						headerCssStyles: tableHeader,
						valueType: azdata.DeclarativeDataType.string,
						width: /*'14%',*/100,
						rowCssStyles: rowStyle,
						isReadOnly: true
					},
					{
						displayName: 'Check ID',
						headerCssStyles: tableHeader,
						valueType: azdata.DeclarativeDataType.string,
						width: /*'7%',*/60,
						rowCssStyles: rowStyle,
						isReadOnly: true
					}
				],
				data: [],
			})
			.component();


		return table;
	}

	private transformItem(item: mssql.SqlAssessmentResultItem, assessmentType: AssessmentType): any[] {
		return [
			item.targetName,
			item.level,
			this.modelView.modelBuilder.text().withProperties<azdata.TextComponentProperties>({
				value: `<span class='cls1'>${(assessmentType === AssessmentType.AvailableRules ? item.description : item.message)}</span>{0}`,
				links: [
					{ text: 'Show more', url: item.helpLink }
				],
				CSSStyles: {
					'margin': '0px'
				}
			}).component(),
			item.tags.slice(1).join(', '),
			item.checkId
		];
	}

	private displayResults(result: mssql.SqlAssessmentResult, assessmentType: AssessmentType): void {
		this.apiVersionPropItem.value = result.apiVersion;
		this.defaultRulesetPropItem.value = result.items[0].rulesetVersion;
		this.assessmentPropertiesContainer.propertyItems = [
			this.apiVersionPropItem,
			this.defaultRulesetPropItem
		];

		this.lastInvokedResults = result.items;

		if (assessmentType === AssessmentType.InvokeAssessment) {
			this.btnExportAsScript.enabled = true;
		} else {
			this.btnExportAsScript.enabled = false;
		}

		this.tblResults.data = result.items.map(item => this.transformItem(item, assessmentType));
	}


	private appendResults(results: mssql.SqlAssessmentResultItem[], assessmentType: AssessmentType): void {
		this.lastInvokedResults.push(...results);

		this.tblResults.data = this.lastInvokedResults.map(item => this.transformItem(item, assessmentType));
	}
}

