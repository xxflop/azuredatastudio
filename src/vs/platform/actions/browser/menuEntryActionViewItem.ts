/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addClasses, createCSSRule, removeClasses, asCSSUrl } from 'vs/base/browser/dom';
import { domEvent } from 'vs/base/browser/event';
import { IAction, Separator } from 'vs/base/common/actions';
import { Emitter } from 'vs/base/common/event';
import { IdGenerator } from 'vs/base/common/idGenerator';
import { IDisposable, toDisposable, MutableDisposable, DisposableStore, dispose } from 'vs/base/common/lifecycle';
import { isLinux, isWindows } from 'vs/base/common/platform';
import { localize } from 'vs/nls';
import { ICommandAction, IMenu, IMenuActionOptions, MenuItemAction, SubmenuItemAction, Icon } from 'vs/platform/actions/common/actions';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { ThemeIcon } from 'vs/platform/theme/common/themeService';
import { ActionViewItem } from 'vs/base/browser/ui/actionbar/actionViewItems';
import { DropdownMenuActionViewItem } from 'vs/base/browser/ui/dropdown/dropdownActionViewItem';

// The alternative key on all platforms is alt. On windows we also support shift as an alternative key #44136
class AlternativeKeyEmitter extends Emitter<boolean> {

	private readonly _subscriptions = new DisposableStore();
	private _isPressed: boolean = false;
	private static instance: AlternativeKeyEmitter;
	private _suppressAltKeyUp: boolean = false;

	private constructor(contextMenuService: IContextMenuService) {
		super();

		this._subscriptions.add(domEvent(document.body, 'keydown')(e => {
			this.isPressed = e.altKey || ((isWindows || isLinux) && e.shiftKey);
		}));
		this._subscriptions.add(domEvent(document.body, 'keyup')(e => {
			if (this.isPressed) {
				if (this._suppressAltKeyUp) {
					e.preventDefault();
				}
			}

			this._suppressAltKeyUp = false;
			this.isPressed = false;
		}));
		this._subscriptions.add(domEvent(document.body, 'mouseleave')(e => this.isPressed = false));
		this._subscriptions.add(domEvent(document.body, 'blur')(e => this.isPressed = false));
		// Workaround since we do not get any events while a context menu is shown
		this._subscriptions.add(contextMenuService.onDidContextMenu(() => this.isPressed = false));
	}

	get isPressed(): boolean {
		return this._isPressed;
	}

	set isPressed(value: boolean) {
		this._isPressed = value;
		this.fire(this._isPressed);
	}

	suppressAltKeyUp() {
		// Sometimes the native alt behavior needs to be suppresed since the alt was already used as an alternative key
		// Example: windows behavior to toggle tha top level menu #44396
		this._suppressAltKeyUp = true;
	}

	static getInstance(contextMenuService: IContextMenuService) {
		if (!AlternativeKeyEmitter.instance) {
			AlternativeKeyEmitter.instance = new AlternativeKeyEmitter(contextMenuService);
		}

		return AlternativeKeyEmitter.instance;
	}

	dispose() {
		super.dispose();
		this._subscriptions.dispose();
	}
}

export function createAndFillInContextMenuActions(menu: IMenu, options: IMenuActionOptions | undefined, target: IAction[] | { primary: IAction[]; secondary: IAction[]; }, contextMenuService: IContextMenuService, isPrimaryGroup?: (group: string) => boolean): IDisposable {
	const groups = menu.getActions(options);
	const useAlternativeActions = AlternativeKeyEmitter.getInstance(contextMenuService).isPressed;
	fillInActions(groups, target, useAlternativeActions, isPrimaryGroup);
	return asDisposable(groups);
}

export function createAndFillInActionBarActions(menu: IMenu, options: IMenuActionOptions | undefined, target: IAction[] | { primary: IAction[]; secondary: IAction[]; }, isPrimaryGroup?: (group: string) => boolean): IDisposable {
	const groups = menu.getActions(options);
	// Action bars handle alternative actions on their own so the alternative actions should be ignored
	fillInActions(groups, target, false, isPrimaryGroup);
	return asDisposable(groups);
}

function asDisposable(groups: ReadonlyArray<[string, ReadonlyArray<MenuItemAction | SubmenuItemAction>]>): IDisposable {
	const disposables = new DisposableStore();
	for (const [, actions] of groups) {
		for (const action of actions) {
			disposables.add(action);
		}
	}
	return disposables;
}

// {{SQL CARBON EDIT}} add export modifier
export function fillInActions(groups: ReadonlyArray<[string, ReadonlyArray<MenuItemAction | SubmenuItemAction>]>, target: IAction[] | { primary: IAction[]; secondary: IAction[]; }, useAlternativeActions: boolean, isPrimaryGroup: (group: string) => boolean = group => group === 'navigation'): void {
	for (let tuple of groups) {
		let [group, actions] = tuple;
		if (useAlternativeActions) {
			actions = actions.map(a => (a instanceof MenuItemAction) && !!a.alt ? a.alt : a);
		}

		if (isPrimaryGroup(group)) {
			const to = Array.isArray<IAction>(target) ? target : target.primary;

			to.unshift(...actions);
		} else {
			const to = Array.isArray<IAction>(target) ? target : target.secondary;

			if (to.length > 0) {
				to.push(new Separator());
			}

			to.push(...actions);
		}
	}
}

const ids = new IdGenerator('menu-item-action-item-icon-');

const ICON_PATH_TO_CSS_RULES = new Map<string /* path*/, string /* CSS rule */>();

export class MenuEntryActionViewItem extends ActionViewItem {

	private _wantsAltCommand: boolean = false;
	private readonly _itemClassDispose = this._register(new MutableDisposable());
	private readonly _altKey: AlternativeKeyEmitter;

	constructor(
		readonly _action: MenuItemAction,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@INotificationService protected _notificationService: INotificationService,
		@IContextMenuService _contextMenuService: IContextMenuService
	) {
		super(undefined, _action, { icon: !!(_action.class || _action.item.icon), label: !_action.class && !_action.item.icon });
		this._altKey = AlternativeKeyEmitter.getInstance(_contextMenuService);
	}

	protected get _commandAction(): IAction {
		return this._wantsAltCommand && (<MenuItemAction>this._action).alt || this._action;
	}

	onClick(event: MouseEvent): void {
		event.preventDefault();
		event.stopPropagation();

		if (this._altKey.isPressed) {
			this._altKey.suppressAltKeyUp();
		}

		this.actionRunner.run(this._commandAction, this._context)
			.then(undefined, err => this._notificationService.error(err));
	}

	render(container: HTMLElement): void {
		super.render(container);

		this._updateItemClass(this._action.item);

		let mouseOver = false;

		let alternativeKeyDown = this._altKey.isPressed;

		const updateAltState = () => {
			const wantsAltCommand = mouseOver && alternativeKeyDown;
			if (wantsAltCommand !== this._wantsAltCommand) {
				this._wantsAltCommand = wantsAltCommand;
				this.updateLabel();
				this.updateTooltip();
				this.updateClass();
			}
		};

		if (this._action.alt) {
			this._register(this._altKey.event(value => {
				alternativeKeyDown = value;
				updateAltState();
			}));
		}

		this._register(domEvent(container, 'mouseleave')(_ => {
			mouseOver = false;
			updateAltState();
		}));

		this._register(domEvent(container, 'mouseenter')(e => {
			mouseOver = true;
			updateAltState();
		}));
	}

	updateLabel(): void {
		if (this.options.label && this.label) {
			this.label.textContent = this._commandAction.label;
		}
	}

	updateTooltip(): void {
		if (this.label) {
			const keybinding = this._keybindingService.lookupKeybinding(this._commandAction.id);
			const keybindingLabel = keybinding && keybinding.getLabel();

			const tooltip = this._commandAction.tooltip || this._commandAction.label;
			this.label.title = keybindingLabel
				? localize('titleAndKb', "{0} ({1})", tooltip, keybindingLabel)
				: tooltip;
		}
	}

	updateClass(): void {
		if (this.options.icon) {
			if (this._commandAction !== this._action) {
				if (this._action.alt) {
					this._updateItemClass(this._action.alt.item);
				}
			} else if ((<MenuItemAction>this._action).alt) {
				this._updateItemClass(this._action.item);
			}
		}
	}

	protected _updateItemClass(item: ICommandAction): void { // {{SQL CARBON EDIT}} make it overwritable
		this._itemClassDispose.value = undefined;

		const icon = this._commandAction.checked && (item.toggled as { icon?: Icon })?.icon ? (item.toggled as { icon: Icon }).icon : item.icon;

		if (ThemeIcon.isThemeIcon(icon)) {
			// theme icons
			const iconClass = ThemeIcon.asClassName(icon);
			if (this.label && iconClass) {
				addClasses(this.label, iconClass);
				this._itemClassDispose.value = toDisposable(() => {
					if (this.label) {
						removeClasses(this.label, iconClass);
					}
				});
			}

		} else if (icon) {
			// icon path
			let iconClass: string;

			if (icon.dark?.scheme) {

				const iconPathMapKey = icon.dark.toString();

				if (ICON_PATH_TO_CSS_RULES.has(iconPathMapKey)) {
					iconClass = ICON_PATH_TO_CSS_RULES.get(iconPathMapKey)!;
				} else {
					iconClass = ids.nextId();
					createCSSRule(`.icon.${iconClass}`, `background-image: ${asCSSUrl(icon.light || icon.dark)}`);
					createCSSRule(`.vs-dark .icon.${iconClass}, .hc-black .icon.${iconClass}`, `background-image: ${asCSSUrl(icon.dark)}`);
					ICON_PATH_TO_CSS_RULES.set(iconPathMapKey, iconClass);
				}

				if (this.label) {

					addClasses(this.label, 'icon', iconClass);
					this._itemClassDispose.value = toDisposable(() => {
						if (this.label) {
							removeClasses(this.label, 'icon', iconClass);
						}
					});
				}
			}
		}
	}
}

export class SubmenuEntryActionViewItem extends DropdownMenuActionViewItem {

	constructor(
		action: SubmenuItemAction,
		@INotificationService _notificationService: INotificationService,
		@IContextMenuService _contextMenuService: IContextMenuService
	) {
		const classNames: string[] = [];

		if (action.item.icon) {
			if (ThemeIcon.isThemeIcon(action.item.icon)) {
				classNames.push(ThemeIcon.asClassName(action.item.icon)!);
			} else if (action.item.icon.dark?.scheme) {
				const iconPathMapKey = action.item.icon.dark.toString();

				if (ICON_PATH_TO_CSS_RULES.has(iconPathMapKey)) {
					classNames.push('icon', ICON_PATH_TO_CSS_RULES.get(iconPathMapKey)!);
				} else {
					const className = ids.nextId();
					classNames.push('icon', className);
					createCSSRule(`.icon.${className}`, `background-image: ${asCSSUrl(action.item.icon.light || action.item.icon.dark)}`);
					createCSSRule(`.vs-dark .icon.${className}, .hc-black .icon.${className}`, `background-image: ${asCSSUrl(action.item.icon.dark)}`);
					ICON_PATH_TO_CSS_RULES.set(iconPathMapKey, className);
				}
			}
		}

		super(action, action.actions, _contextMenuService, { classNames });
	}
}

// {{SQL CARBON EDIT}} - This is here to use the 'ids' generator above
// Always show label for action items, instead of whether they don't have
// an icon/CSS class. Useful for some toolbar scenarios in particular with
// contributed actions from other extensions
export class LabeledMenuItemActionItem extends MenuEntryActionViewItem {
	private _labeledItemClassDispose?: IDisposable;

	constructor(
		public _action: MenuItemAction,
		@IKeybindingService labeledkeybindingService: IKeybindingService,
		@IContextMenuService labeledcontextMenuService: IContextMenuService,
		@INotificationService protected _notificationService: INotificationService,
		private readonly _defaultCSSClassToAdd: string = ''
	) {
		super(_action, labeledkeybindingService, _notificationService, labeledcontextMenuService);
	}

	updateLabel(): void {
		if (this.label) {
			this.label.innerText = this._commandAction.label;
		}
	}

	// Overwrite item class to ensure that we can pass in a CSS class that other items use
	// Leverages the _defaultCSSClassToAdd property that's passed into the constructor
	protected _updateItemClass(item: ICommandAction): void {
		dispose(this._labeledItemClassDispose);
		this._labeledItemClassDispose = undefined;

		if (ThemeIcon.isThemeIcon(item.icon)) {
			// TODO
		} else if (item.icon) {
			let iconClass: string;


			if (item.icon?.dark?.scheme) {
				const iconPathMapKey = item.icon.dark.toString();

				if (ICON_PATH_TO_CSS_RULES.has(iconPathMapKey)) {
					iconClass = ICON_PATH_TO_CSS_RULES.get(iconPathMapKey)!;
				} else {
					iconClass = ids.nextId();
					createCSSRule(`.codicon.${iconClass}`, `background-image: ${asCSSUrl(item.icon.light || item.icon.dark)}`);
					createCSSRule(`.vs-dark .codicon.${iconClass}, .hc-black .codicon.${iconClass}`, `background-image: ${asCSSUrl(item.icon.dark)}`);
					ICON_PATH_TO_CSS_RULES.set(iconPathMapKey, iconClass);
				}

				if (this.label) {
					addClasses(this.label, 'codicon', this._defaultCSSClassToAdd, iconClass);
					this._labeledItemClassDispose = toDisposable(() => {
						if (this.label) {
							removeClasses(this.label, 'codicon', this._defaultCSSClassToAdd, iconClass);
						}
					});
				}
			}
		}
	}

	dispose(): void {
		if (this._labeledItemClassDispose) {
			dispose(this._labeledItemClassDispose);
			this._labeledItemClassDispose = undefined;
		}

		super.dispose();
	}
}
// {{SQL CARBON EDIT}} - End