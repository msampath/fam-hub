// Registers @testing-library/jest-dom matchers (toBeInTheDocument, toBeDisabled, …)
// with Vitest's expect. Import-safe under both the node and jsdom environments;
// the matchers only touch the DOM when actually invoked (i.e. in jsdom component tests).
import '@testing-library/jest-dom/vitest';

// NOTE: jsdom does not implement form submission via submit-button activation
// (HTMLFormElement._doRequestSubmit throws "Not implemented"). Component tests must
// therefore trigger form onSubmit with fireEvent.submit(form) rather than clicking a
// type="submit" button.
