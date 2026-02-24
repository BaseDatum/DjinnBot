import SwiftUI
import AppKit

/// Tracks the mouse position relative to the bottom edge of the hosting window.
/// When the mouse Y-position is within `triggerDistance` of the bottom, sets `isNearBottom` to true.
///
/// Uses an NSTrackingArea on the hosting NSView for efficient, low-overhead tracking.
final class BottomEdgeDetector: ObservableObject {
    @Published var isNearBottom: Bool = false
    
    /// Distance from bottom edge (in points) that triggers the toolbar.
    let triggerDistance: CGFloat = 60
    
    /// Debounce delay before hiding (prevents flicker when moving mouse slightly).
    private let hideDelay: TimeInterval = 0.4
    private var hideTimer: Timer?
    
    func mouseMovedInWindow(mouseY: CGFloat, windowHeight: CGFloat) {
        let distanceFromBottom = mouseY // In flipped coordinates, mouseY is from bottom
        
        if distanceFromBottom < triggerDistance {
            hideTimer?.invalidate()
            hideTimer = nil
            if !isNearBottom {
                isNearBottom = true
            }
        } else {
            // Start debounce timer for hiding
            if isNearBottom && hideTimer == nil {
                hideTimer = Timer.scheduledTimer(withTimeInterval: hideDelay, repeats: false) { [weak self] _ in
                    DispatchQueue.main.async {
                        self?.isNearBottom = false
                        self?.hideTimer = nil
                    }
                }
            }
        }
    }
    
    /// Force show (e.g., from keyboard shortcut).
    func forceShow() {
        hideTimer?.invalidate()
        hideTimer = nil
        isNearBottom = true
    }
    
    /// Force hide.
    func forceHide() {
        hideTimer?.invalidate()
        hideTimer = nil
        isNearBottom = false
    }
}

// MARK: - NSView Mouse Tracking Wrapper

/// An invisible NSView that installs an NSTrackingArea for mouse movement
/// and reports position changes to the BottomEdgeDetector.
struct MouseTrackingView: NSViewRepresentable {
    let detector: BottomEdgeDetector
    
    func makeNSView(context: Context) -> MouseTrackingNSView {
        let view = MouseTrackingNSView()
        view.detector = detector
        return view
    }
    
    func updateNSView(_ nsView: MouseTrackingNSView, context: Context) {
        nsView.detector = detector
    }
}

class MouseTrackingNSView: NSView {
    weak var detector: BottomEdgeDetector?
    private var trackingArea: NSTrackingArea?
    
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        
        if let existing = trackingArea {
            removeTrackingArea(existing)
        }
        
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }
    
    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        
        guard let window = self.window else { return }
        
        // Convert to window coordinates — mouseY from bottom
        let locationInWindow = event.locationInWindow
        let windowHeight = window.frame.height
        
        detector?.mouseMovedInWindow(mouseY: locationInWindow.y, windowHeight: windowHeight)
    }
    
    override var acceptsFirstResponder: Bool { false }
}
