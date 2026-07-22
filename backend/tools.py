from anti_client import Tool

TOOLS = [
    Tool(
        name="set_fill_color",
        description="Задать сплошную заливку объекта.",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": "string", "description": "Идентификатор объекта"},
                "hex_color": {
                    "type": "string",
                    "description": "Цвет в формате #RRGGBB",
                },
            },
            "required": ["ref", "hex_color"],
        },
    ),
    Tool(
        name="set_position",
        description="Переместить объект в абсолютные координаты страницы (в текущих единицах измерения документа doc.Unit).",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "x": {"type": "number"},
                "y": {"type": "number"},
            },
            "required": ["ref", "x", "y"],
        },
    ),
    Tool(
        name="set_size",
        description="Задать ширину и высоту объекта (в текущих единицах измерения документа doc.Unit).",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "width": {"type": "number"},
                "height": {"type": "number"},
            },
            "required": ["ref", "width", "height"],
        },
    ),
    Tool(
        name="rotate",
        description="Повернуть объект на заданный угол в градусах.",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "angle": {"type": "number"},
            },
            "required": ["ref", "angle"],
        },
    ),
    Tool(
        name="duplicate",
        description="Продублировать объект. Возвращает ref новой копии.",
        parameters={
            "type": "object",
            "properties": {"ref": {"type": "string"}},
            "required": ["ref"],
        },
    ),
    Tool(
        name="delete_shape",
        description="Удалить объект из документа.",
        parameters={
            "type": "object",
            "properties": {"ref": {"type": "string"}},
            "required": ["ref"],
        },
    ),
    Tool(
        name="convert_to_curves",
        description="Преобразовать объект в кривые перед точечным редактированием контура.",
        parameters={
            "type": "object",
            "properties": {"ref": {"type": "string"}},
            "required": ["ref"],
        },
    ),
    Tool(
        name="order",
        description="Изменить порядок наложения объекта.",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": "string"},
                "mode": {
                    "type": "string",
                    "enum": ["front", "back", "forward", "backward"],
                },
            },
            "required": ["ref", "mode"],
        },
    ),
    Tool(
        name="export_svg",
        description="Получить актуальные векторные SVG-данные объекта.",
        parameters={
            "type": "object",
            "properties": {"ref": {"type": "string"}},
            "required": ["ref"],
        },
    ),
    Tool(
        name="import_svg",
        description="Создать новый объект из SVG-разметки.",
        parameters={
            "type": "object",
            "properties": {
                "svg": {"type": "string", "description": "Полная SVG-разметка"},
                "x": {"type": "number"},
                "y": {"type": "number"},
            },
            "required": ["svg"],
        },
    ),
    Tool(
        name="trace_bitmap",
        description=(
            "Трассировать (векторизовать) растровое изображение — PowerTRACE. "
            "Результат появляется поверх оригинала и возвращается как new_refs; "
            "исходный битмап по умолчанию не удаляется."
        ),
        parameters={
            "type": "object",
            "properties": {
                "ref": {
                    "type": "string",
                    "description": "Идентификатор растрового объекта",
                },
                "style": {
                    "type": "string",
                    "enum": [
                        "line_art",
                        "logo",
                        "detailed_logo",
                        "clipart",
                        "low_quality_image",
                        "high_quality_image",
                        "technical",
                        "line_drawing",
                    ],
                    "description": "Пресет трассировки (соответствует стилям PowerTRACE)",
                },
            },
            "required": ["ref", "style"],
        },
    ),
    Tool(
        name="get_page_info",
        description="Узнать размер текущей страницы/листа и единицу измерения (doc.Unit).",
        parameters={"type": "object", "properties": {}, "required": []},
    ),
    Tool(
        name="set_text",
        description="Изменить содержимое текстового блока.",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": "string", "description": "Идентификатор текстового объекта"},
                "text": {"type": "string", "description": "Новый текст"},
            },
            "required": ["ref", "text"],
        },
    ),
    Tool(
        name="group_shapes",
        description="Сгруппировать несколько выделенных объектов в одну группу.",
        parameters={
            "type": "object",
            "properties": {
                "refs": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Список идентификаторов объектов для группировки",
                },
            },
            "required": ["refs"],
        },
    ),
    Tool(
        name="ungroup_shapes",
        description="Разгруппировать группу объектов.",
        parameters={
            "type": "object",
            "properties": {
                "ref": {"type": "string", "description": "Идентификатор группы объектов"},
            },
            "required": ["ref"],
        },
    ),
    Tool(
        name="align_objects",
        description="Выровнять объекты относительно друг друга или страницы.",
        parameters={
            "type": "object",
            "properties": {
                "refs": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Список идентификаторов объектов для выравнивания",
                },
                "align_h": {
                    "type": "string",
                    "enum": ["left", "center", "right", "none"],
                    "description": "Выравнивание по горизонтали: left, center, right",
                },
                "align_v": {
                    "type": "string",
                    "enum": ["top", "center", "bottom", "none"],
                    "description": "Выравнивание по вертикали: top, center, bottom",
                },
                "relative_to": {
                    "type": "string",
                    "enum": ["selection", "page"],
                    "description": "Относительно выделения или страницы (по умолчанию selection)",
                },
            },
            "required": ["refs"],
        },
    ),
]
