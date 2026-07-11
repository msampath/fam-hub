import { storageMode } from '../storage';

export const STORAGE_MODE = storageMode();
export const LOCAL_MODE = STORAGE_MODE === 'sqlite';
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const PORT = Number(process.env.PORT) || 4894;
