export const DEFAULT_PARAGRAPH_ALIGNMENT = 'ragged-right';
export const TEX_INTERWORD_SPACE_EM = 0.3333;
export const TEX_INTERWORD_STRETCH_EM = 1 / 6;
export const TEX_INTERWORD_SHRINK_EM = 1 / 9;
export const TIKZ_RAGGED_SKIP_STRETCH_EM = 2;
export function normalizeParagraphAlignment(value) {
    if (value === 'ragged-right' ||
        value === 'ragged-left' ||
        value === 'center' ||
        value === 'justified') {
        return value;
    }
    return DEFAULT_PARAGRAPH_ALIGNMENT;
}
export function buildAlignmentProfile(alignment) {
    if (alignment === 'ragged-left') {
        return {
            alignment,
            interwordStretch: 0,
            interwordShrink: 0,
            leftskip: { width: 0, stretch: TIKZ_RAGGED_SKIP_STRETCH_EM, shrink: 0 },
            rightskip: { width: 0, stretch: 0, shrink: 0 },
            parfillskip: { width: 0, stretch: 0, shrink: 0 },
            preventOverflow: false,
        };
    }
    if (alignment === 'justified') {
        return {
            alignment,
            interwordStretch: TEX_INTERWORD_STRETCH_EM,
            interwordShrink: TEX_INTERWORD_SHRINK_EM,
            leftskip: { width: 0, stretch: 0, shrink: 0 },
            rightskip: { width: 0, stretch: 0, shrink: 0 },
            parfillskip: { width: 0, stretch: Number.POSITIVE_INFINITY, shrink: 0 },
            preventOverflow: false,
        };
    }
    if (alignment === 'center') {
        return {
            alignment,
            interwordStretch: 0,
            interwordShrink: 0,
            leftskip: { width: 0, stretch: TIKZ_RAGGED_SKIP_STRETCH_EM, shrink: 0 },
            rightskip: { width: 0, stretch: TIKZ_RAGGED_SKIP_STRETCH_EM, shrink: 0 },
            parfillskip: { width: 0, stretch: 0, shrink: 0 },
            preventOverflow: false,
        };
    }
    return {
        alignment: 'ragged-right',
        interwordStretch: 0,
        interwordShrink: 0,
        leftskip: { width: 0, stretch: 0, shrink: 0 },
        rightskip: { width: 0, stretch: TIKZ_RAGGED_SKIP_STRETCH_EM, shrink: 0 },
        parfillskip: { width: 0, stretch: Number.POSITIVE_INFINITY, shrink: 0 },
        preventOverflow: false,
    };
}
