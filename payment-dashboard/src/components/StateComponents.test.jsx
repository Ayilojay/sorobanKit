import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PartialDataBanner,
} from './StateComponents';

describe('StateComponents', () => {
  describe('EmptyState', () => {
    it('renders with a status role and accessible label', () => {
      render(<EmptyState title="No results" description="Try another search" />);
      const region = screen.getByRole('status');
      expect(region).toBeInTheDocument();
      expect(region).toHaveAttribute('aria-live', 'polite');
      expect(screen.getByText('No results')).toBeInTheDocument();
      expect(screen.getByText('Try another search')).toBeInTheDocument();
    });

    it('is distinct from an error state (no alert role)', () => {
      render(<EmptyState title="No results" />);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('renders a page-specific recovery action when provided', () => {
      const onAction = vi.fn();
      render(
        <EmptyState
          title="No results"
          actionLabel="Clear filters"
          onAction={onAction}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(onAction).toHaveBeenCalledTimes(1);
    });

    it('does not render an action button when no action is provided', () => {
      render(<EmptyState title="No results" />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('ErrorState', () => {
    it('renders with an alert role and live region', () => {
      render(<ErrorState title="Something went wrong" description="Please retry" />);
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveAttribute('aria-live', 'assertive');
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      expect(screen.getByText('Please retry')).toBeInTheDocument();
    });

    it('invokes the retry action when retry is clicked', () => {
      const onRetry = vi.fn();
      render(<ErrorState title="Failed" onRetry={onRetry} />);
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('does not render a retry button when no retry handler is provided', () => {
      render(<ErrorState title="Failed" />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('is distinct from an empty state (alert role present)', () => {
      render(<ErrorState title="Failed" />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  describe('LoadingState', () => {
    it('renders with a status role and polite live region', () => {
      render(<LoadingState label="Loading payments" />);
      const status = screen.getByRole('status');
      expect(status).toBeInTheDocument();
      expect(status).toHaveAttribute('aria-live', 'polite');
      expect(status).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByText('Loading payments')).toBeInTheDocument();
    });

    it('uses a default label when none is provided', () => {
      render(<LoadingState />);
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  });

  describe('PartialDataBanner', () => {
    it('renders with a status role and preserves primary content', () => {
      render(
        <PartialDataBanner message="Some data could not be loaded">
          <div data-testid="primary-content">Primary content</div>
        </PartialDataBanner>,
      );
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.getByText('Some data could not be loaded')).toBeInTheDocument();
      expect(screen.getByTestId('primary-content')).toBeInTheDocument();
      expect(screen.getByText('Primary content')).toBeInTheDocument();
    });

    it('invokes the retry action when retry is clicked', () => {
      const onRetry = vi.fn();
      render(
        <PartialDataBanner message="Partial failure" onRetry={onRetry}>
          <div>Content</div>
        </PartialDataBanner>,
      );
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('does not render a retry button when no retry handler is provided', () => {
      render(
        <PartialDataBanner message="Partial failure">
          <div>Content</div>
        </PartialDataBanner>,
      );
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('does not use an alert role so primary content remains usable', () => {
      render(
        <PartialDataBanner message="Partial failure">
          <div>Content</div>
        </PartialDataBanner>,
      );
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  });
});