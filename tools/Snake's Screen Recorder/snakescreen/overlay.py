"""Full-screen transparent overlays: the region picker and the region outline HUD."""

import os

from PyQt6.QtCore import QPoint, QRect, Qt, QUrl, pyqtSignal
from PyQt6.QtGui import QColor, QFont, QGuiApplication, QPainter, QPen
from PyQt6.QtWidgets import QWidget

from .platforms import KIND

ACCENT = QColor("#7ee787")  # snake_theme.HIGHLIGHT
MIN_SIZE = 16

# Sets LayerShellQt's attached properties on a window that was not made in QML.
_LAYER_QML = b"""
import QtQml
import org.kde.layershell
QtObject {
    property var target
    onTargetChanged: {
        target.Window.scope = "snakescreen-outline"
        target.Window.layer = Window.LayerOverlay
        target.Window.anchors = Window.AnchorTop | Window.AnchorBottom | Window.AnchorLeft | Window.AnchorRight
        target.Window.exclusionZone = -1
        target.Window.keyboardInteractivity = Window.KeyboardInteractivityNone
    }
}
"""
_layer_engine = None


def _put_on_overlay_layer(widget):
    """Wayland: make the (not yet shown) window a layer-shell surface above everything.

    A normal Wayland window cannot keep itself on top: the compositor drops it
    behind whichever window is clicked next. Returns False where layer-shell is
    not available (no LayerShellQt, or GNOME), leaving the window as it was.
    """
    global _layer_engine
    if KIND != "portal" or "GNOME" in os.environ.get("XDG_CURRENT_DESKTOP", "").upper():
        return False
    try:
        from PyQt6.QtQml import QQmlComponent, QQmlEngine
    except ImportError:
        return False
    if _layer_engine is None:
        _layer_engine = QQmlEngine()
    component = QQmlComponent(_layer_engine)
    component.setData(_LAYER_QML, QUrl())
    setter = component.create()
    if setter is None:
        return False
    widget.winId()  # creates the QWindow the properties attach to
    setter.setProperty("target", widget.windowHandle())
    return True


class _ScreenOverlay(QWidget):
    """Frameless, see-through window covering exactly one screen."""

    def __init__(self, screen, extra_flags=Qt.WindowType.Widget):
        super().__init__(None, Qt.WindowType.FramelessWindowHint
                         | Qt.WindowType.WindowStaysOnTopHint
                         | Qt.WindowType.Tool | extra_flags)
        self.target_screen = screen
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setScreen(screen)
        self.setGeometry(screen.geometry())

    def present(self):
        self.showFullScreen()


class RegionPicker(_ScreenOverlay):
    """Dims one screen and lets the user drag out a rectangle."""

    picked = pyqtSignal(object, QRect)  # QScreen, rect relative to that screen
    cancelled = pyqtSignal()

    def __init__(self, screen):
        super().__init__(screen)
        self.setCursor(Qt.CursorShape.CrossCursor)
        self.setMouseTracking(True)
        self._origin = None
        self._rect = QRect()

    def keyPressEvent(self, event):
        if event.key() == Qt.Key.Key_Escape:
            self.cancelled.emit()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._origin = event.position().toPoint()
            self._rect = QRect(self._origin, self._origin)
            self.update()
        elif event.button() == Qt.MouseButton.RightButton:
            self.cancelled.emit()

    def mouseMoveEvent(self, event):
        if self._origin is not None:
            self._rect = QRect(self._origin, event.position().toPoint()).normalized() & self.rect()
            self.update()

    def mouseReleaseEvent(self, event):
        if event.button() != Qt.MouseButton.LeftButton or self._origin is None:
            return
        self._origin = None
        if self._rect.width() >= MIN_SIZE and self._rect.height() >= MIN_SIZE:
            self.picked.emit(self.target_screen, QRect(self._rect))
        else:
            self._rect = QRect()
            self.update()

    def paintEvent(self, _event):
        p = QPainter(self)
        shade = QColor(0, 0, 0, 110)
        r = self._rect
        if r.isEmpty():
            p.fillRect(self.rect(), shade)
            hint = "Drag to select the area to record\nEsc or right-click to cancel"
            p.setFont(QFont(self.font().family(), 16))
            box = p.fontMetrics().boundingRect(self.rect(), Qt.AlignmentFlag.AlignCenter, hint)
            p.setRenderHint(QPainter.RenderHint.Antialiasing)
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(0, 0, 0, 200))
            p.drawRoundedRect(box.adjusted(-24, -16, 24, 16), 10, 10)
            p.setPen(Qt.GlobalColor.white)
            p.drawText(box, Qt.AlignmentFlag.AlignCenter, hint)
            return
        # shade everything except the selection
        w, h = self.width(), self.height()
        p.fillRect(0, 0, w, r.top(), shade)
        p.fillRect(0, r.bottom() + 1, w, h - r.bottom() - 1, shade)
        p.fillRect(0, r.top(), r.left(), r.height(), shade)
        p.fillRect(r.right() + 1, r.top(), w - r.right() - 1, r.height(), shade)
        p.setPen(QPen(ACCENT, 2))
        p.drawRect(r.adjusted(-1, -1, 1, 1))
        label = f"{r.width()} × {r.height()}"
        p.setFont(QFont(self.font().family(), 11, QFont.Weight.Bold))
        box = p.fontMetrics().boundingRect(label).adjusted(-6, -3, 6, 3)
        pos = QPoint(r.left(), r.top() - box.height() - 6)
        if pos.y() < 0:
            pos.setY(r.top() + 6)
        box.moveTopLeft(pos)
        p.fillRect(box, QColor(0, 0, 0, 190))
        p.setPen(Qt.GlobalColor.white)
        p.drawText(box, Qt.AlignmentFlag.AlignCenter, label)


class RegionPickerSession:
    """Shows a picker on every screen; the first selection wins."""

    def __init__(self, on_picked, on_cancelled):
        self._on_picked = on_picked
        self._on_cancelled = on_cancelled
        self._pickers = []
        for screen in QGuiApplication.screens():
            picker = RegionPicker(screen)
            picker.picked.connect(self._picked)
            picker.cancelled.connect(self._cancelled)
            self._pickers.append(picker)
            picker.present()
        if self._pickers:
            self._pickers[0].activateWindow()

    def _picked(self, screen, rect):
        self.close()
        self._on_picked(screen, rect)

    def _cancelled(self):
        self.close()
        self._on_cancelled()

    def close(self):
        for picker in self._pickers:
            picker.close()
            picker.deleteLater()
        self._pickers = []


class Hud(_ScreenOverlay):
    """Click-through overlay showing the countdown and the region outline.

    The outline is drawn just outside the recorded region, so it never ends up
    in the video.
    """

    def __init__(self, screen):
        super().__init__(screen, Qt.WindowType.WindowTransparentForInput
                         | Qt.WindowType.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.region = None   # QRect or None
        self.count = None    # int or None
        self.paused = False
        self._layered = _put_on_overlay_layer(self)

    def present(self):
        if self._layered:
            self.show()  # the compositor sizes it to the screen
        else:
            super().present()

    def paintEvent(self, _event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        if self.region is not None:
            pen = QPen(ACCENT, 2, Qt.PenStyle.DashLine if self.paused else Qt.PenStyle.SolidLine)
            p.setPen(pen)
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRect(self.region.adjusted(-3, -3, 2, 2))
        if self.count is not None:
            area = self.region if self.region is not None else self.rect()
            size = 150
            circle = QRect(0, 0, size, size)
            circle.moveCenter(area.center())
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(0, 0, 0, 170))
            p.drawEllipse(circle)
            p.setPen(Qt.GlobalColor.white)
            p.setFont(QFont(self.font().family(), 64, QFont.Weight.Bold))
            p.drawText(circle, Qt.AlignmentFlag.AlignCenter, str(self.count))
