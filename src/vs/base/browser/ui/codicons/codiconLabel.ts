/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { reset } from 'vs/base/browser/dom';
import { renderCodiconsAsElement } from 'vs/base/browser/codicons';

export class CodiconLabel {

	constructor(
		private readonly _container: HTMLElement
	) { }

	set text(text: string) {
		reset(this._container, ...renderCodiconsAsElement(text ?? ''));
	}

	set title(title: string) {
		this._container.title = title;
	}
}
