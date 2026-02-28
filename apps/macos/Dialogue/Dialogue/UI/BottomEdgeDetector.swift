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

// MARK: - Sidebar Edge Detector

/// Tracks the mouse position relative to the left edge of the hosting window.
/// When the sidebar is collapsed and the mouse X-position is within `triggerDistance`
/// of the left edge, sets `isNearLeftEdge` to true so the sidebar can auto-reveal.
/// Once revealed, the sidebar stays open as long as the mouse remains within the
/// sidebar area (`sidebarWidth`).
final class SidebarEdgeDetector: ObservableObject {
    @Published var isNearLeftEdge: Bool = false

    /// Whether the user has manually collapsed the sidebar.
    /// Auto-reveal only activates when this is true.
    @Published var sidebarCollapsedByUser: Bool = false

    /// Narrow zone from the left edge (in points) that initially triggers the reveal.
    let triggerDistance: CGFloat = 10

    /// Width of the sidebar area. While the sidebar is revealed and the mouse
    /// stays within this zone, it remains open.
    var sidebarWidth: CGFloat = 250

    /// Debounce delay before hiding (prevents flicker when the mouse briefly
    /// crosses the sidebar boundary).
    private let hideDelay: TimeInterval = 0.35
    private var hideTimer: Timer?

    func mouseMovedInWindow(mouseX: CGFloat) {
        guard sidebarCollapsedByUser else { return }

        // Determine the active zone: narrow trigger to open, full sidebar width to stay open.
        let activeZone: CGFloat = isNearLeftEdge ? sidebarWidth : triggerDistance

        if mouseX < activeZone {
            hideTimer?.invalidate()
            hideTimer = nil
            if !isNearLeftEdge {
                isNearLeftEdge = true
            }
        } else {
            if isNearLeftEdge && hideTimer == nil {
                hideTimer = Timer.scheduledTimer(withTimeInterval: hideDelay, repeats: false) { [weak self] _ in
                    DispatchQueue.main.async {
                        self?.isNearLeftEdge = false
                        self?.hideTimer = nil
                    }
                }
            }
        }
    }

    /// Call when the user explicitly toggles the sidebar (e.g., toolbar button).
    func userCollapsedSidebar() {
        sidebarCollapsedByUser = true
    }

    func userExpandedSidebar() {
        sidebarCollapsedByUser = false
        hideTimer?.invalidate()
        hideTimer = nil
        isNearLeftEdge = false
    }
}

// MARK: - NSView Mouse Tracking Wrapper

/// An invisible NSView that installs an NSTrackingArea for mouse movement
/// and reports position changes to the BottomEdgeDetector.
struct MouseTrackingView: NSViewRepresentable {
    let detector: BottomEdgeDetector
    var sidebarDetector: SidebarEdgeDetector? = nil
    
    func makeNSView(context: Context) -> MouseTrackingNSView {
        let view = MouseTrackingNSView()
        view.detector = detector
        view.sidebarDetector = sidebarDetector
        return view
    }
    
    func updateNSView(_ nsView: MouseTrackingNSView, context: Context) {
        nsView.detector = detector
        nsView.sidebarDetector = sidebarDetector
    }
}

class MouseTrackingNSView: NSView {
    weak var detector: BottomEdgeDetector?
    weak var sidebarDetector: SidebarEdgeDetector?
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
        
        let locationInWindow = event.locationInWindow
        let windowHeight = window.frame.height
        
        detector?.mouseMovedInWindow(mouseY: locationInWindow.y, windowHeight: windowHeight)
        sidebarDetector?.mouseMovedInWindow(mouseX: locationInWindow.x)
    }
    
    override var acceptsFirstResponder: Bool { false }
}
