// Worker wire format. The public ConvertRequest (../types) carries no colours, so the worker request adds
// the colour list given to createPhotoConverter (see report: contract note).

import type { BrickColor } from '../../model/types';
import type { ConvertMessage, ConvertRequest } from '../types';

export type WorkerRequest = ConvertRequest & { colors: BrickColor[] };
export type WorkerMessage = ConvertMessage;
